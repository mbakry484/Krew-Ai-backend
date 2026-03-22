const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
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

// POST /conversations/:id/reset-metadata - Reset conversation metadata for testing
router.post('/:id/reset-metadata', async (req, res) => {
  try {
    const { id } = req.params;

    // Reset metadata to empty state
    const { data, error } = await supabase
      .from('conversations')
      .update({
        metadata: {
          discussed_products: [],
          current_order: null,
          collected_info: { name: null, phone: null, address: null },
          awaiting: null
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error(`❌ Error: ${error.message}`);
      return res.status(500).json({ error: 'Failed to reset metadata', details: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    console.log(`✅ Reset metadata for conversation ${id}`);
    res.json({
      success: true,
      message: 'Metadata reset successfully',
      metadata: data.metadata
    });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to reset metadata', details: error.message });
  }
});

module.exports = router;
