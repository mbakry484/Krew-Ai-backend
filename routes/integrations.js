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
      .eq('account_id', shop_domain)
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
      .update({ user_id: userId })
      .eq('account_id', shop_domain)
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
 */
router.get('/shopify/status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Check if user has a Shopify integration
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('account_id')
      .eq('user_id', userId)
      .eq('platform', 'shopify')
      .single();

    if (fetchError || !integration) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      shop_domain: integration.account_id
    });
  } catch (error) {
    console.error('Shopify status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
