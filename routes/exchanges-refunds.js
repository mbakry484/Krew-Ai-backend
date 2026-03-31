const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

/**
 * Map internal DB status to frontend status values (pending | done | dismissed)
 */
function toFrontendStatus(dbStatus) {
  if (!dbStatus || dbStatus === 'pending' || dbStatus === 'approved' || dbStatus === 'shipped' || dbStatus === 'processed') {
    return 'pending';
  }
  if (dbStatus === 'completed') return 'done';
  if (dbStatus === 'rejected' || dbStatus === 'closed' || dbStatus === 'dismissed') return 'dismissed';
  return 'pending';
}

/**
 * Map frontend status to DB status value
 */
function toDbStatus(frontendStatus) {
  if (frontendStatus === 'done') return 'completed';
  if (frontendStatus === 'dismissed') return 'rejected';
  return 'pending';
}

/**
 * GET /exchanges-refunds
 * Fetch all exchanges and refunds for the authenticated user's brand.
 * Query params:
 *   - status: 'all' | 'pending' | 'done' | 'dismissed' (default: 'all')
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { status = 'all' } = req.query;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brand_id = user.brand_id;

    // Fetch exchanges and refunds in parallel
    const [{ data: exchanges, error: exErr }, { data: refunds, error: refErr }] = await Promise.all([
      supabase.from('exchanges').select('*').eq('brand_id', brand_id).order('created_at', { ascending: false }),
      supabase.from('refunds').select('*').eq('brand_id', brand_id).order('created_at', { ascending: false }),
    ]);

    if (exErr) {
      console.error('❌ Error fetching exchanges:', exErr.message);
      return res.status(500).json({ error: exErr.message });
    }
    if (refErr) {
      console.error('❌ Error fetching refunds:', refErr.message);
      return res.status(500).json({ error: refErr.message });
    }

    // Normalize exchanges to frontend shape
    const normalizedExchanges = (exchanges || []).map((e) => ({
      id: e.id,
      type: 'exchange',
      status: toFrontendStatus(e.status),
      customer_name: e.customer_name || e.customer_id,
      order_id: e.original_order_number || '—',
      date: e.created_at,
      reason: e.exchange_reason_details || e.exchange_reason || '—',
      conversation_id: e.conversation_id || null,
    }));

    // Normalize refunds to frontend shape
    const normalizedRefunds = (refunds || []).map((r) => ({
      id: r.id,
      type: 'refund',
      status: toFrontendStatus(r.status),
      customer_name: r.customer_name || r.customer_id,
      order_id: r.original_order_number || '—',
      date: r.created_at,
      reason: r.refund_reason_details || r.refund_reason || '—',
      conversation_id: r.conversation_id || null,
    }));

    let all = [...normalizedExchanges, ...normalizedRefunds];

    // Filter by frontend status if requested
    if (status !== 'all') {
      all = all.filter((r) => r.status === status);
    }

    res.json({ requests: all });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /exchanges-refunds/:type/:id/status
 * Mark an exchange or refund as done or dismissed.
 * :type = 'exchange' | 'refund'
 * Body: { status: 'done' | 'dismissed' }
 */
router.patch('/:type/:id/status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { type, id } = req.params;
    const { status } = req.body;

    if (!['exchange', 'refund'].includes(type)) {
      return res.status(400).json({ error: 'type must be exchange or refund' });
    }
    if (!['done', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'status must be done or dismissed' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const table = type === 'exchange' ? 'exchanges' : 'refunds';
    const dbStatus = toDbStatus(status);

    const updatePayload = {
      status: dbStatus,
      updated_at: new Date().toISOString(),
    };
    if (status === 'done') {
      updatePayload.resolved_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from(table)
      .update(updatePayload)
      .eq('id', id)
      .eq('brand_id', user.brand_id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: `${type} not found` });
    }

    res.json({ success: true, id, status });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
