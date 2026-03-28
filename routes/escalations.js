const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

/**
 * GET /escalations
 * Fetch all escalated conversations for a brand
 * Query params:
 *   - brand_id: UUID (required)
 *   - type: string (optional) - Filter by escalation type
 *   - limit: number (optional, default 50)
 */
router.get('/', async (req, res) => {
  try {
    const { brand_id, type, limit = 50 } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    let query = supabase
      .from('escalated_conversations')
      .select('*')
      .eq('brand_id', brand_id)
      .limit(limit);

    // Filter by escalation type if provided
    if (type) {
      query = query.eq('escalation_type', type);
    }

    const { data, error } = await query;

    if (error) {
      console.error('❌ Error fetching escalations:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      escalations: data,
      count: data.length
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /escalations/:conversation_id/resolve
 * Mark an escalated conversation as resolved
 */
router.post('/:conversation_id/resolve', async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const { resolved_by, notes } = req.body;

    // Update conversation to remove escalation
    const { data, error } = await supabase
      .from('conversations')
      .update({
        is_escalated: false,
        status: 'resolved',
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation_id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error resolving escalation:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Optional: Log resolution in messages table
    if (notes) {
      await supabase
        .from('messages')
        .insert({
          conversation_id,
          sender: 'human',
          content: `[Escalation Resolved] ${notes}`,
          created_at: new Date().toISOString()
        });
    }

    console.log(`✅ Escalation resolved for conversation ${conversation_id}`);
    res.json({
      message: 'Escalation resolved successfully',
      conversation: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /escalations/:conversation_id/reopen
 * Re-enable AI responses for a conversation (clear escalation flag)
 */
router.post('/:conversation_id/reopen', async (req, res) => {
  try {
    const { conversation_id } = req.params;

    const { data, error } = await supabase
      .from('conversations')
      .update({
        is_escalated: false,
        escalation_type: null,
        escalation_reason: null,
        escalated_at: null,
        status: 'active',
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation_id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error reopening conversation:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Conversation ${conversation_id} reopened for AI responses`);
    res.json({
      message: 'Conversation reopened successfully - AI can now respond',
      conversation: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /escalations/stats
 * Get escalation statistics for a brand
 */
router.get('/stats', async (req, res) => {
  try {
    const { brand_id } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    // Get counts by type
    const { data: typeStats, error: typeError } = await supabase
      .from('conversations')
      .select('escalation_type')
      .eq('brand_id', brand_id)
      .eq('is_escalated', true);

    if (typeError) {
      console.error('❌ Error fetching stats:', typeError.message);
      return res.status(500).json({ error: typeError.message });
    }

    // Count by type
    const stats = {
      total: typeStats.length,
      by_type: {
        exchange: typeStats.filter(s => s.escalation_type === 'exchange').length,
        refund: typeStats.filter(s => s.escalation_type === 'refund').length,
        delivery: typeStats.filter(s => s.escalation_type === 'delivery').length,
        general: typeStats.filter(s => s.escalation_type === 'general').length
      }
    };

    res.json(stats);
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
