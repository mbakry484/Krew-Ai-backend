const express = require('express');
const router = express.Router();
// const supabase = require('../lib/supabase');
// const { verifyToken } = require('../middleware/auth');

// TODO: Implement knowledge base management routes
// - GET /knowledge-base - Get knowledge base for a brand
// - POST /knowledge-base - Create/update knowledge base (protected)
// - PUT /knowledge-base/:id - Update knowledge base (protected)
// - DELETE /knowledge-base/:id - Delete knowledge base (protected)

router.get('/', (req, res) => {
  res.status(501).json({ message: 'Get knowledge base endpoint not yet implemented' });
});

router.post('/', (req, res) => {
  res.status(501).json({ message: 'Create knowledge base endpoint not yet implemented' });
});

router.put('/:id', (req, res) => {
  res.status(501).json({ message: 'Update knowledge base endpoint not yet implemented' });
});

router.delete('/:id', (req, res) => {
  res.status(501).json({ message: 'Delete knowledge base endpoint not yet implemented' });
});

module.exports = router;
