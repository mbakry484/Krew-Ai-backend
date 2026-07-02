const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { generateEmbeddingsForBrand } = require('../lib/embeddings');
const { getShopName, getStorefrontUrl, getValidAccessToken, SHOPIFY_API_VERSION } = require('../lib/shopify');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Page size per Shopify request. 50 keeps each request's query cost well under
// Shopify's cost limit given the nested images/variants connections.
const PRODUCT_PAGE_SIZE = 50;

// Fetch ALL active products from Shopify (following pagination cursors) and
// upsert them into Supabase page by page.
async function autoSyncProducts({ shop, access_token, brand_id }) {
  console.log(`🔄 Auto-syncing products for ${shop}...`);

  const query = `
    query SyncProducts($first: Int!, $cursor: String) {
      products(first: $first, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title handle description onlineStoreUrl productType
            images(first: 20) { edges { node { url altText width height } } }
            variants(first: 10) { edges { node { id title price inventoryQuantity } } }
          }
        }
      }
    }`;

  const syncedAt = new Date().toISOString();
  let cursor = null;
  let hasNextPage = true;
  let page = 0;
  let totalSynced = 0;

  while (hasNextPage) {
    // Fetch one page, retrying when Shopify's cost-based rate limiter throttles us.
    let json;
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': access_token,
          },
          body: JSON.stringify({
            query,
            variables: { first: PRODUCT_PAGE_SIZE, cursor },
          }),
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ Shopify GraphQL ${response.status} response body:`, errorBody);
        console.error(`❌ Token used (first 10 chars): ${access_token?.substring(0, 10)}...`);
        console.error(`❌ URL called: https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
        throw new Error(`Shopify GraphQL error: ${response.status}`);
      }

      json = await response.json();

      // Throttling returns HTTP 200 with a THROTTLED error — back off and retry.
      const throttled = json.errors?.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled) {
        const status = json.extensions?.cost?.throttleStatus;
        const needed = json.extensions?.cost?.requestedQueryCost || 0;
        const waitMs = status && status.restoreRate
          ? Math.max(1000, ((needed - status.currentlyAvailable) / status.restoreRate) * 1000)
          : 1000 * attempt;
        console.warn(`⏳ Throttled by Shopify (attempt ${attempt}), waiting ${Math.round(waitMs)}ms…`);
        await sleep(waitMs);
        continue;
      }

      if (json.errors?.length) {
        console.error('❌ Shopify GraphQL errors:', JSON.stringify(json.errors));
        throw new Error(`Shopify GraphQL error: ${json.errors[0]?.message || 'unknown'}`);
      }

      break;
    }

    const connection = json.data?.products;
    const edges = connection?.edges || [];

    if (edges.length > 0) {
      const productsToUpsert = edges.map(({ node }) => {
        const variants = node.variants.edges.map(e => e.node);
        const inStock = variants.some(v => (v.inventoryQuantity ?? 0) > 0);
        const images = node.images.edges.map(e => ({
          url: e.node.url,
          altText: e.node.altText || '',
          width: e.node.width,
          height: e.node.height,
        })).filter(img => img.url);

        return {
          user_id: brand_id,
          brand_id,
          shopify_product_id: node.id,
          name: node.title,
          handle: node.handle || null,
          online_store_url: node.onlineStoreUrl || null,
          product_type: node.productType || null,
          description: node.description || null,
          price: parseFloat(variants[0]?.price || '0'),
          currency: 'EGP',
          variants,
          in_stock: inStock,
          availability: inStock ? 'in_stock' : 'out_of_stock',
          image_url: images[0]?.url || null,
          images,
          synced_at: syncedAt,
          updated_at: syncedAt,
        };
      });

      const { error } = await supabase
        .from('products')
        .upsert(productsToUpsert, { onConflict: 'shopify_product_id', ignoreDuplicates: false });

      if (error) throw error;

      totalSynced += productsToUpsert.length;
    }

    page++;
    hasNextPage = connection?.pageInfo?.hasNextPage || false;
    cursor = connection?.pageInfo?.endCursor || null;
    console.log(`  📦 Page ${page}: ${edges.length} products (total ${totalSynced}) for ${shop}`);

    // Proactively wait if the cost budget is too low to afford the next page.
    const cost = json.extensions?.cost;
    if (hasNextPage && cost?.throttleStatus?.restoreRate) {
      const { currentlyAvailable, restoreRate } = cost.throttleStatus;
      const needed = cost.requestedQueryCost || 0;
      if (currentlyAvailable < needed) {
        const waitMs = ((needed - currentlyAvailable) / restoreRate) * 1000;
        console.log(`  ⏸ Cost budget low (${currentlyAvailable}/${needed}), waiting ${Math.round(waitMs)}ms…`);
        await sleep(waitMs);
      }
    }
  }

  if (totalSynced === 0) return;

  console.log(`✅ Auto-synced ${totalSynced} active products for brand ${brand_id}`);

  // Generate embeddings in background
  generateEmbeddingsForBrand(brand_id).catch(err =>
    console.error('❌ Embedding error after auto-sync:', err.message)
  );
}

/**
 * POST /integrations/shopify/connect
 * Initiate Shopify OAuth flow (protected route)
 */
router.post('/shopify/connect', verifyToken, async (req, res) => {
  try {
    const { shop_domain } = req.body;
    const userId = req.user.user_id;

    // Validate required field
    if (!shop_domain) {
      return res.status(400).json({ error: 'shop_domain is required' });
    }

    // Validate shop_domain format - must end in .myshopify.com
    if (!shop_domain.endsWith('.myshopify.com')) {
      return res.status(400).json({
        error: 'Invalid shop_domain format. Must end in .myshopify.com'
      });
    }

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(400).json({ error: 'No brand found for this user' });
    }

    const brandId = user.brand_id;

    // Check if this Shopify store is already connected to another brand
    const { data: existingShopify } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .maybeSingle();

    if (existingShopify && existingShopify.brand_id !== brandId) {
      return res.status(409).json({ error: 'This Shopify store is already connected to another brand' });
    }

    const backendUrl = process.env.BACKEND_URL || 'https://krew-ai-backend-production.up.railway.app';

    // Generate state parameter by signing brand_id and shop_domain with JWT_SECRET
    const state = jwt.sign(
      { brand_id: brandId, user_id: userId, shop_domain },
      process.env.JWT_SECRET,
      { expiresIn: '10m' } // State expires in 10 minutes for security
    );

    // Build Shopify OAuth URL
    const scopes = 'read_products,write_products,read_orders,write_orders,read_inventory';
    const redirectUri = `${backendUrl}/integrations/shopify/callback`;
    const oauthUrl = `https://${shop_domain}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirectUri}&state=${state}`;

    res.json({ oauth_url: oauthUrl });
  } catch (error) {
    console.error('Shopify OAuth initiation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /integrations/shopify/callback
 * Shopify OAuth callback (unprotected - called by Shopify)
 */
router.get('/shopify/callback', async (req, res) => {
  try {
    const { code, shop, state } = req.query;

    // Set FRONTEND_URL with fallback
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // Validate required parameters
    if (!code || !shop || !state) {
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=missing_params`);
    }

    // Verify and decode state to extract user_id
    let decoded;
    try {
      decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch (error) {
      console.error('Invalid or expired state:', error);
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=invalid_state`);
    }

    const { brand_id, shop_domain } = decoded;

    if (!brand_id) {
      console.error('No brand_id in state');
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=invalid_state`);
    }

    // Verify that the shop matches the one in the state
    if (shop !== shop_domain) {
      console.error('Shop mismatch:', shop, shop_domain);
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=shop_mismatch`);
    }

    // Exchange authorization code for access token
    // Per Shopify docs: do NOT send grant_type for code exchange — only client_id, client_secret, code
    // Send expiring=1 to get an expiring offline token with refresh_token
    const tokenExchangeUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenResponse = await fetch(tokenExchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
        expiring: 1,
      })
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      console.error(`Failed to exchange code for token (${tokenResponse.status}):`, errBody);
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=token_exchange_failed`);
    }

    const tokenData = await tokenResponse.json();
    console.log('🔑 Shopify token response:', JSON.stringify(tokenData, null, 2));
    const { access_token, refresh_token, expires_in } = tokenData;

    if (!access_token) {
      console.error('No access token received from Shopify');
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=no_token`);
    }

    if (!refresh_token) {
      console.warn('⚠️ No refresh_token received — Shopify returned a non-expiring token. Token will work but cannot be rotated.');
    }

    // Calculate token expiry (Shopify expiring tokens last ~1 hour)
    const token_expires_at = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null;

    // Fetch the brand's published storefront domain (custom domain if configured,
    // else the .myshopify.com). Used to build clickable product links in DMs.
    let storefront_url = null;
    try {
      storefront_url = await getStorefrontUrl(shop, access_token);
    } catch (err) {
      console.error('⚠️ Failed to fetch storefront URL:', err.message);
    }

    // Upsert into integrations table using the authenticated brand_id
    const { error: upsertError } = await supabase
      .from('integrations')
      .upsert({
        brand_id,
        shopify_shop_domain: shop,
        access_token,
        refresh_token: refresh_token || null,
        token_expires_at,
        storefront_url,
        platform: 'shopify'
      }, {
        onConflict: 'shopify_shop_domain'
      });

    if (upsertError) {
      console.error('Error upserting integration:', upsertError);
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=db_error`);
    }

    // Redirect to the Shopify embedded app so user sees the progress bar
    const shopifyAppUrl = `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`;
    res.redirect(shopifyAppUrl);

    // Auto-sync products in background after OAuth completes
    autoSyncProducts({ shop, access_token, brand_id }).catch(err =>
      console.error('❌ Auto-sync failed after OAuth:', err.message)
    );
  } catch (error) {
    console.error('Shopify OAuth callback error:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=server_error`);
  }
});

/**
 * POST /integrations/shopify/link
 * Link a Shopify store to the authenticated user
 */
router.post('/shopify/link', verifyToken, async (req, res) => {
  try {
    const { shop_domain } = req.body;
    const userId = req.user.user_id;

    // Validate required field
    if (!shop_domain) {
      return res.status(400).json({ error: 'shop_domain is required' });
    }

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(400).json({ error: 'No brand found for this user' });
    }

    // Look up the integration in Supabase
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('*')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    if (fetchError || !integration) {
      return res.status(404).json({
        error: 'Store not found. Make sure the Krew app is installed on this store.'
      });
    }

    // Update the integration to link it to the brand
    const { error: updateError } = await supabase
      .from('integrations')
      .update({ brand_id: user.brand_id })
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify');

    if (updateError) {
      console.error('Error updating integration:', updateError);
      return res.status(500).json({ error: 'Failed to link store' });
    }

    res.json({
      success: true,
      shop_domain
    });
  } catch (error) {
    console.error('Shopify link error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /integrations/shopify/resync
 * Re-sync ALL products for the authenticated user's connected Shopify store.
 * Follows Shopify's pagination cursors to pull the entire catalog — use this to
 * backfill stores connected before full-catalog sync existed, or to force a refresh.
 * Protected - requires JWT authentication. Runs the sync in the background and
 * returns immediately; poll /webhook/shopify/sync-status for progress.
 * Used by: Krew frontend dashboard
 */
router.post('/shopify/resync', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(400).json({ error: 'No brand found for this user' });
    }

    const brandId = user.brand_id;

    // Find the connected Shopify integration for this brand
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('*')
      .eq('brand_id', brandId)
      .eq('platform', 'shopify')
      .maybeSingle();

    if (fetchError || !integration) {
      return res.status(404).json({ error: 'No connected Shopify store found for this brand' });
    }

    // Get a valid access token, refreshing it first if it has expired
    let accessToken;
    try {
      accessToken = await getValidAccessToken(integration);
    } catch (err) {
      console.error('Failed to get valid Shopify token for resync:', err.message);
      return res.status(502).json({
        error: 'Failed to authenticate with Shopify. Try reconnecting the store.',
      });
    }

    const shop = integration.shopify_shop_domain;

    // Kick off the full paginated sync in the background — don't block the response,
    // a large catalog can take a while to walk through every page.
    autoSyncProducts({ shop, access_token: accessToken, brand_id: brandId }).catch(err =>
      console.error(`❌ Manual resync failed for ${shop}:`, err.message)
    );

    res.status(202).json({
      success: true,
      message: 'Product re-sync started. This runs in the background and may take a minute for large catalogs.',
      shop_domain: shop,
    });
  } catch (error) {
    console.error('Shopify resync error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /integrations/shopify/status
 * Check if the authenticated user has a linked Shopify store
 * Protected endpoint - requires JWT authentication
 * Used by: Krew frontend dashboard
 */
router.get('/shopify/status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.json({ linked: false });
    }

    // Query the integrations table by brand_id
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('brand_id', user.brand_id)
      .eq('platform', 'shopify')
      .maybeSingle();

    // No row found or error
    if (fetchError || !integration) {
      return res.json({ linked: false });
    }

    // Integration found and brand_id is not null
    res.json({ linked: true });
  } catch (error) {
    console.error('Shopify status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /integrations/shopify/app-status?shop_domain=example.myshopify.com
 * Check if a Shopify store is linked to a brand
 * Unprotected endpoint - accepts shop_domain as query param
 * Used by: Shopify app embedded in Shopify admin
 */
router.get('/shopify/app-status', async (req, res) => {
  try {
    const { shop_domain } = req.query;

    // Validate required parameter
    if (!shop_domain) {
      return res.status(400).json({ error: 'shop_domain query parameter is required' });
    }

    // Query the integrations table
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .maybeSingle();

    // No row found or error
    if (fetchError || !integration) {
      return res.json({ linked: false });
    }

    // Row exists but brand_id is null
    if (integration.brand_id === null) {
      return res.json({ linked: false });
    }

    // Row exists and brand_id is not null
    res.json({ linked: true });
  } catch (error) {
    console.error('Shopify app-status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /integrations/status
 * Get all integration statuses for the authenticated user's brand
 */
router.get('/status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.json({ shopify: { linked: false }, meta: { linked: false } });
    }

    const brandId = user.brand_id;

    // Query all integrations for this brand
    const { data: integrations, error: fetchError } = await supabase
      .from('integrations')
      .select('platform, shopify_shop_domain, instagram_page_id, access_token, refresh_token, token_expires_at')
      .eq('brand_id', brandId);

    if (fetchError) {
      console.error('Error fetching integrations:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch integration status' });
    }

    const shopify = integrations?.find(i => i.platform === 'shopify');
    const meta = integrations?.find(i => i.platform === 'instagram');

    // Also check brands table for Meta connection info
    const { data: brand } = await supabase
      .from('brands')
      .select('fb_page_id, instagram_business_account_id, page_access_token')
      .eq('id', brandId)
      .single();

    // Fetch Shopify store name via GraphQL (auto-refreshes expired token)
    let shopName = null;
    if (shopify?.shopify_shop_domain && shopify?.access_token) {
      try {
        const validToken = await getValidAccessToken(shopify);
        shopName = await getShopName(shopify.shopify_shop_domain, validToken);
      } catch (err) {
        console.error('Failed to fetch Shopify shop name:', err.message);
      }
    }

    // Fetch Instagram username from Graph API
    let instagramUsername = null;
    const igAccountId = meta?.instagram_page_id || brand?.instagram_business_account_id;
    const igAccessToken = meta?.access_token || brand?.page_access_token;
    if (igAccountId && igAccessToken) {
      try {
        const igRes = await fetch(
          `https://graph.instagram.com/v21.0/me?fields=username&access_token=${igAccessToken}`
        );
        if (igRes.ok) {
          const igData = await igRes.json();
          instagramUsername = igData.username || null;
        }
      } catch (err) {
        console.error('Failed to fetch Instagram username:', err.message);
      }
    }

    res.json({
      shopify: {
        linked: !!shopify,
        shop_domain: shopify?.shopify_shop_domain || null,
        shop_name: shopName,
      },
      meta: {
        linked: !!(meta || brand?.instagram_business_account_id),
        instagram_id: igAccountId || null,
        instagram_username: instagramUsername,
      },
    });
  } catch (error) {
    console.error('Integration status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /integrations/disconnect
 * Disconnect Shopify, Instagram, or both integrations for the authenticated user's brand.
 * Body: { platform: 'shopify' | 'instagram' | 'all' }
 */
router.delete('/disconnect', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { platform } = req.body;

    if (!platform || !['shopify', 'instagram', 'all'].includes(platform)) {
      return res.status(400).json({ error: "platform must be 'shopify', 'instagram', or 'all'" });
    }

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(404).json({ error: 'Brand not found for this user' });
    }

    const brandId = user.brand_id;
    const platformsToRemove = platform === 'all' ? ['shopify', 'instagram'] : [platform];

    // Delete rows from integrations table
    const { error: deleteError } = await supabase
      .from('integrations')
      .delete()
      .eq('brand_id', brandId)
      .in('platform', platformsToRemove);

    if (deleteError) {
      console.error('Error deleting integrations:', deleteError);
      return res.status(500).json({ error: 'Failed to disconnect integration(s)' });
    }

    // Clear related columns on the brands table
    const brandUpdates = {};
    if (platformsToRemove.includes('instagram')) {
      brandUpdates.fb_page_id = null;
      brandUpdates.page_access_token = null;
      brandUpdates.long_lived_user_token = null;
      brandUpdates.token_expires_at = null;
      brandUpdates.instagram_page_id = null;
      brandUpdates.instagram_business_account_id = null;
    }
    if (platformsToRemove.includes('shopify')) {
      // shopify_shop_domain lives on the integrations table, not brands — no brand column to clear
    }

    if (Object.keys(brandUpdates).length > 0) {
      const { error: brandUpdateError } = await supabase
        .from('brands')
        .update(brandUpdates)
        .eq('id', brandId);

      if (brandUpdateError) {
        console.error('Error clearing brand integration fields:', brandUpdateError);
        // Non-fatal: integrations row already deleted, log and continue
      }
    }

    res.json({
      success: true,
      disconnected: platformsToRemove,
    });
  } catch (error) {
    console.error('Disconnect integration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
