const express = require('express');
const router = express.Router();
// const supabase = require('../lib/supabase');
// const { verifyToken } = require('../middleware/auth');

// TODO: Implement conversation management routes
// - GET /conversations - List all conversations for a brand (protected)
// - GET /conversations/:id - Get single conversation with messages (protected)
// - PUT /conversations/:id - Update conversation status (protected)
// - POST /conversations/:id/messages - Send manual message (protected)

router.get('/', (req, res) => {
  res.status(501).json({ message: 'List conversations endpoint not yet implemented' });
});

router.get('/:id', (req, res) => {
  res.status(501).json({ message: 'Get conversation endpoint not yet implemented' });
});

router.put('/:id', (req, res) => {
  res.status(501).json({ message: 'Update conversation endpoint not yet implemented' });
});

router.post('/:id/messages', (req, res) => {
  res.status(501).json({ message: 'Send message endpoint not yet implemented' });
});

module.exports = router;
