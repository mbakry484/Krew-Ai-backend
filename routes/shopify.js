const express = require('express');
const router = express.Router();
// const supabase = require('../lib/supabase');

// TODO: Implement Shopify webhook routes
// - POST /webhook/shopify/orders/create - Handle new order creation
// - POST /webhook/shopify/orders/updated - Handle order updates
// - POST /webhook/shopify/products/create - Handle new product creation
// - POST /webhook/shopify/products/update - Handle product updates
// - GET /webhook/shopify - Webhook verification if needed

router.post('/orders/create', (req, res) => {
  res.status(501).json({ message: 'Shopify order creation webhook not yet implemented' });
});

router.post('/orders/updated', (req, res) => {
  res.status(501).json({ message: 'Shopify order update webhook not yet implemented' });
});

router.post('/products/create', (req, res) => {
  res.status(501).json({ message: 'Shopify product creation webhook not yet implemented' });
});

router.post('/products/update', (req, res) => {
  res.status(501).json({ message: 'Shopify product update webhook not yet implemented' });
});

module.exports = router;
