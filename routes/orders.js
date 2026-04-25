const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

/**
 * GET /orders - Get all orders for the authenticated brand
 * Protected route - requires JWT authentication
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Look up brand_id for this user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(404).json({ error: 'User or brand not found' });
    }

    const brandId = user.brand_id;

    // Fetch all orders for this brand, ordered by created_at DESC
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(`❌ Error: ${error.message}`);
      return res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
    }

    res.json({
      orders: orders || [],
      total: orders?.length || 0
    });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
  }
});

/**
 * GET /orders/stats - Get order statistics for the authenticated brand
 * Protected route - requires JWT authentication
 */
router.get('/stats', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Look up brand_id for this user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(404).json({ error: 'User or brand not found' });
    }

    const brandId = user.brand_id;

    // Fetch all orders for this brand
    const { data: orders, error } = await supabase
      .from('orders')
      .select('price, status')
      .eq('brand_id', brandId);

    if (error) {
      console.error(`❌ Error: ${error.message}`);
      return res.status(500).json({ error: 'Failed to fetch order stats', details: error.message });
    }

    // Calculate statistics
    const total_orders = orders?.length || 0;
    const total_revenue = orders?.reduce((sum, order) => sum + (parseFloat(order.price) || 0), 0) || 0;
    const pending_orders = orders?.filter(order => order.status === 'pending').length || 0;
    const completed_orders = orders?.filter(order => order.status === 'completed').length || 0;

    res.json({
      total_orders,
      total_revenue,
      pending_orders,
      completed_orders
    });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch order stats', details: error.message });
  }
});

module.exports = router;
