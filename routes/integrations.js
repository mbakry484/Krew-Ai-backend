const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

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

    // Log and set BACKEND_URL with fallback
    console.log('BACKEND_URL from env:', process.env.BACKEND_URL);
    const backendUrl = process.env.BACKEND_URL || 'https://krew-ai-backend-production.up.railway.app';
    console.log('Using BACKEND_URL:', backendUrl);

    // Generate state parameter by signing user_id and shop_domain with JWT_SECRET
    const state = jwt.sign(
      { user_id: userId, shop_domain },
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

    // Validate required parameters
    if (!code || !shop || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=error&reason=missing_params`);
    }

    // Verify and decode state to extract user_id
    let decoded;
    try {
      decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch (error) {
      console.error('Invalid or expired state:', error);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=error&reason=invalid_state`);
    }

    const { user_id, shop_domain } = decoded;

    // Verify that the shop matches the one in the state
    if (shop !== shop_domain) {
      console.error('Shop mismatch:', shop, shop_domain);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=error&reason=shop_mismatch`);
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
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=error&reason=token_exchange_failed`);
    }

    const tokenData = await tokenResponse.json();
    const { access_token } = tokenData;

    if (!access_token) {
      console.error('No access token received from Shopify');
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=error&reason=no_token`);
    }

    // Upsert into integrations table
    const { error: upsertError } = await supabase
      .from('integrations')
      .upsert({
        brand_id: user_id,
        shopify_shop_domain: shop,
        access_token,
        platform: 'shopify'
      }, {
        onConflict: 'shopify_shop_domain'
      });

    if (upsertError) {
      console.error('Error upserting integration:', upsertError);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=error&reason=db_error`);
    }

    // Redirect to frontend with success
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=connected`);
  } catch (error) {
    console.error('Shopify OAuth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?shopify=error&reason=server_error`);
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

    // Update the integration to link it to the user
    const { error: updateError } = await supabase
      .from('integrations')
      .update({ brand_id: userId })
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
 * GET /integrations/shopify/status?shop_domain=example.myshopify.com
 * Check if a Shopify store is linked to a brand
 */
router.get('/shopify/status', async (req, res) => {
  try {
    const { shop_domain } = req.query;

    // Validate required parameter
    if (!shop_domain) {
      return res.status(400).json({ error: 'shop_domain query parameter is required' });
    }

    // Query the integrations table by shopify_shop_domain
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('shopify_shop_domain', shop_domain)
      .eq('platform', 'shopify')
      .single();

    // No row found
    if (fetchError || !integration) {
      return res.json({ linked: false });
    }

    // Check if brand_id is not null
    if (integration.brand_id === null) {
      return res.json({ linked: false });
    }

    // brand_id is not null, store is linked
    res.json({ linked: true });
  } catch (error) {
    console.error('Shopify status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /integrations/shopify/status?shop_domain=example.myshopify.com
 * Check if a Shopify store is linked (unprotected endpoint)
 */
router.get('/shopify/link-status', async (req, res) => {
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
      .single();

    // No row found
    if (fetchError || !integration) {
      return res.json({ linked: false });
    }

    // Row exists but brand_id is null
    if (integration.brand_id === null) {
      return res.json({ linked: false });
    }

    // Row exists and brand_id is not null
    res.json({
      linked: true,
      user_id: integration.brand_id
    });
  } catch (error) {
    console.error('Shopify link status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
