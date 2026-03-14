const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

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
