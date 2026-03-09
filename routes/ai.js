const express = require('express');
const router = express.Router();
// const { generateReply } = require('../lib/claude');
// const { verifyToken } = require('../middleware/auth');

// TODO: Implement AI-related routes
// - POST /ai/generate - Generate AI response for testing (protected)
// - PUT /ai/settings - Update AI settings for brand (protected)
// - GET /ai/settings - Get AI settings for brand (protected)

router.post('/generate', (req, res) => {
  res.status(501).json({ message: 'AI generate endpoint not yet implemented' });
});

router.get('/settings', (req, res) => {
  res.status(501).json({ message: 'Get AI settings endpoint not yet implemented' });
});

router.put('/settings', (req, res) => {
  res.status(501).json({ message: 'Update AI settings endpoint not yet implemented' });
});

module.exports = router;
