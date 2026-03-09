const express = require('express');
const router = express.Router();
// const supabase = require('../lib/supabase');
// const { verifyToken } = require('../middleware/auth');

// TODO: Implement product management routes
// - GET /products - List all products for a brand
// - GET /products/:id - Get single product details
// - POST /products - Create new product (protected)
// - PUT /products/:id - Update product (protected)
// - DELETE /products/:id - Delete product (protected)

router.get('/', (req, res) => {
  res.status(501).json({ message: 'List products endpoint not yet implemented' });
});

router.get('/:id', (req, res) => {
  res.status(501).json({ message: 'Get product endpoint not yet implemented' });
});

router.post('/', (req, res) => {
  res.status(501).json({ message: 'Create product endpoint not yet implemented' });
});

router.put('/:id', (req, res) => {
  res.status(501).json({ message: 'Update product endpoint not yet implemented' });
});

router.delete('/:id', (req, res) => {
  res.status(501).json({ message: 'Delete product endpoint not yet implemented' });
});

module.exports = router;
