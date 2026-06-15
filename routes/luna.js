const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

/**
 * GET /luna/global-status
 * Returns the global Luna enabled/disabled state for the authenticated user's brand.
 */
router.get('/global-status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .select('luna_global_enabled')
      .eq('id', user.brand_id)
      .single();

    if (brandError || !brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    return res.json({ luna_global_enabled: brand.luna_global_enabled ?? true });
  } catch (err) {
    console.error('Error fetching Luna global status:', err);
    return res.status(500).json({ error: 'Failed to fetch Luna global status' });
  }
});

/**
 * PUT /luna/global-status
 * Updates the global Luna enabled/disabled state for the authenticated user's brand.
 * Body: { luna_global_enabled: boolean }
 */
router.put('/global-status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { luna_global_enabled } = req.body;

    if (typeof luna_global_enabled !== 'boolean') {
      return res.status(400).json({ error: 'luna_global_enabled must be a boolean' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { error: updateError } = await supabase
      .from('brands')
      .update({ luna_global_enabled })
      .eq('id', user.brand_id);

    if (updateError) {
      console.error('Error updating Luna global status:', updateError);
      return res.status(500).json({ error: 'Failed to update Luna global status' });
    }

    return res.json({ success: true, luna_global_enabled });
  } catch (err) {
    console.error('Error updating Luna global status:', err);
    return res.status(500).json({ error: 'Failed to update Luna global status' });
  }
});

module.exports = router;
