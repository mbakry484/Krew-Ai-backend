const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { generateEmbeddingsForBrand } = require('../lib/embeddings');

// Fetch all products from Shopify and upsert them into Supabase
async function autoSyncProducts({ shop, access_token, brand_id }) {
  console.log(`🔄 Auto-syncing products for ${shop}...`);

  const response = await fetch(
    `https://${shop}/admin/api/2024-10/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': access_token,
      },
      body: JSON.stringify({
        query: `{
          products(first: 50) {
            edges {
              node {
                id title description
                images(first: 20) { edges { node { url altText width height } } }
                variants(first: 10) { edges { node { price inventoryQuantity } } }
              }
            }
          }
        }`
      }),
    }
  );

  if (!response.ok) throw new Error(`Shopify GraphQL error: ${response.status}`);

  const json = await response.json();
  const products = json.data?.products?.edges || [];
  if (products.length === 0) return;

  const syncedAt = new Date().toISOString();

  const productsToUpsert = products.map(({ node }) => {
    const variants = node.variants.edges.map(e => e.node);
    const images = node.images.edges.map(e => ({
      url: e.node.url,
      altText: e.node.altText || '',
      width: e.node.width,
      height: e.node.height,
    })).filter(img => img.url);
    const inStock = variants.some(v => (v.inventoryQuantity ?? 0) > 0);

    return {
      user_id: brand_id,
      brand_id,
      shopify_product_id: node.id,
      name: node.title,
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

  console.log(`✅ Auto-synced ${products.length} products for brand ${brand_id}`);

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
    const scopes = 'read_products,write_products';
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

    // Exchange code for access_token
    const tokenExchangeUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenResponse = await fetch(tokenExchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      })
    });

    if (!tokenResponse.ok) {
      console.error('Failed to exchange code for token:', tokenResponse.status);
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=token_exchange_failed`);
    }

    const tokenData = await tokenResponse.json();
    const { access_token } = tokenData;

    if (!access_token) {
      console.error('No access token received from Shopify');
      return res.redirect(`${frontendUrl}/dashboard?shopify=error&reason=no_token`);
    }

    // Upsert into integrations table using the authenticated brand_id
    const { error: upsertError } = await supabase
      .from('integrations')
      .upsert({
        brand_id,
        shopify_shop_domain: shop,
        access_token,
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
      .select('platform, shopify_shop_domain, instagram_page_id, access_token')
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

    // Fetch Shopify store name from Shopify REST API
    let shopName = null;
    if (shopify?.shopify_shop_domain && shopify?.access_token) {
      try {
        const shopRes = await fetch(
          `https://${shopify.shopify_shop_domain}/admin/api/2024-10/shop.json`,
          { headers: { 'X-Shopify-Access-Token': shopify.access_token } }
        );
        if (shopRes.ok) {
          const shopData = await shopRes.json();
          shopName = shopData.shop?.name || null;
        }
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
          `https://graph.facebook.com/v21.0/${igAccountId}?fields=username&access_token=${igAccessToken}`
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
      brandUpdates.shopify_shop_domain = null;
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
