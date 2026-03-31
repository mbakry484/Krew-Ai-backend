const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
// const { verifyToken } = require('../middleware/auth');

// GET /conversations - List all conversations for the brand ordered by last_message_at DESC
router.get('/', async (req, res) => {
  try {
    const { brand_id } = req.query;
    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id query parameter is required' });
    }

    const { data, error } = await supabase
      .from('conversations')
      .select('id, customer_name, customer_username, status, last_message, last_message_at, channel, is_luna_active')
      .eq('brand_id', brand_id)
      .order('last_message_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch conversations', details: error.message });
    }

    res.json({ conversations: data || [] });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch conversations', details: error.message });
  }
});

// GET /conversations/:id/messages - Returns all messages for a conversation ordered by sent_at ASC
router.get('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('sent_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }

    res.json({ messages: data || [] });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
});

// POST /conversations/:id/takeover - Human takes over, Luna stops responding
router.post('/:id/takeover', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('conversations')
      .update({ is_luna_active: false, status: 'escalated' })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to take over conversation', details: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    console.log(`🛑 Human took over conversation ${id}`);
    res.json({ success: true, conversation: data });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to take over conversation', details: error.message });
  }
});

// POST /conversations/:id/handback - Hand conversation back to Luna
router.post('/:id/handback', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('conversations')
      .update({ is_luna_active: true, status: 'active' })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to hand back conversation', details: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    console.log(`▶️ Luna resumed conversation ${id}`);
    res.json({ success: true, conversation: data });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to hand back conversation', details: error.message });
  }
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
