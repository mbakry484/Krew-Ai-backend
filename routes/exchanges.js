const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

/**
 * GET /exchanges
 * Fetch all exchanges for a brand
 * Query params:
 *   - brand_id: UUID (required)
 *   - status: string (optional) - Filter by status
 *   - limit: number (optional, default 50)
 */
router.get('/', async (req, res) => {
  try {
    const { brand_id, status, limit = 50 } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    let query = supabase
      .from('exchanges')
      .select('*')
      .eq('brand_id', brand_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    // Filter by status if provided
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('❌ Error fetching exchanges:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      exchanges: data,
      count: data.length
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /exchanges/pending
 * Fetch all pending exchanges using the view
 */
router.get('/pending', async (req, res) => {
  try {
    const { brand_id } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const { data, error } = await supabase
      .from('pending_exchanges')
      .select('*')
      .eq('brand_id', brand_id);

    if (error) {
      console.error('❌ Error fetching pending exchanges:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      pending_exchanges: data,
      count: data.length
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /exchanges/:id
 * Get a specific exchange by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('exchanges')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('❌ Error fetching exchange:', error.message);
      return res.status(404).json({ error: 'Exchange not found' });
    }

    res.json({ exchange: data });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /exchanges
 * Create a new exchange request
 */
router.post('/', async (req, res) => {
  try {
    const {
      brand_id,
      conversation_id,
      order_id,
      customer_id,
      customer_name,
      customer_phone,
      customer_address,
      original_order_number,
      original_product_name,
      original_product_sku,
      original_size,
      original_color,
      requested_product_name,
      requested_size,
      requested_color,
      exchange_reason,
      exchange_reason_details,
      evidence_images
    } = req.body;

    // Validation
    if (!brand_id || !customer_id || !original_product_name || !exchange_reason) {
      return res.status(400).json({
        error: 'Missing required fields: brand_id, customer_id, original_product_name, exchange_reason'
      });
    }

    const { data, error } = await supabase
      .from('exchanges')
      .insert({
        brand_id,
        conversation_id,
        order_id,
        customer_id,
        customer_name,
        customer_phone,
        customer_address,
        original_order_number,
        original_product_name,
        original_product_sku,
        original_size,
        original_color,
        requested_product_name,
        requested_size,
        requested_color,
        exchange_reason,
        exchange_reason_details,
        evidence_images: evidence_images || [],
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating exchange:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Exchange request created: ${data.id}`);
    res.status(201).json({
      message: 'Exchange request created successfully',
      exchange: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /exchanges/:id
 * Update exchange status or details
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      requested_product_name,
      requested_size,
      requested_color,
      internal_notes,
      resolved_by,
      resolution_details
    } = req.body;

    const updateData = {};

    if (status) updateData.status = status;
    if (requested_product_name) updateData.requested_product_name = requested_product_name;
    if (requested_size) updateData.requested_size = requested_size;
    if (requested_color) updateData.requested_color = requested_color;
    if (internal_notes) updateData.internal_notes = internal_notes;
    if (resolved_by) updateData.resolved_by = resolved_by;
    if (resolution_details) updateData.resolution_details = resolution_details;

    // If status is completed or closed, set resolved_at
    if (status && ['completed', 'closed', 'rejected'].includes(status)) {
      updateData.resolved_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('exchanges')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating exchange:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Exchange updated: ${id} - Status: ${status || 'unchanged'}`);
    res.json({
      message: 'Exchange updated successfully',
      exchange: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /exchanges/:id/approve
 * Approve an exchange request
 */
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approved_by, notes, requested_product_name, requested_size, requested_color } = req.body;

    const updateData = {
      status: 'approved',
      resolved_by: approved_by,
      internal_notes: notes
    };

    if (requested_product_name) updateData.requested_product_name = requested_product_name;
    if (requested_size) updateData.requested_size = requested_size;
    if (requested_color) updateData.requested_color = requested_color;

    const { data, error } = await supabase
      .from('exchanges')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error approving exchange:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Exchange approved: ${id} by ${approved_by}`);
    res.json({
      message: 'Exchange approved successfully',
      exchange: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /exchanges/:id/reject
 * Reject an exchange request
 */
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { rejected_by, reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const { data, error } = await supabase
      .from('exchanges')
      .update({
        status: 'rejected',
        resolved_by: rejected_by,
        resolution_details: `Rejected: ${reason}`,
        resolved_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error rejecting exchange:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Exchange rejected: ${id}`);
    res.json({
      message: 'Exchange rejected',
      exchange: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /exchanges/:id/ship
 * Mark exchange item as shipped
 */
router.post('/:id/ship', async (req, res) => {
  try {
    const { id } = req.params;
    const { tracking_number, shipped_by, notes } = req.body;

    const updateData = {
      status: 'shipped',
      resolved_by: shipped_by,
      resolution_details: notes
    };

    if (tracking_number) {
      updateData.resolution_details = `${notes || ''}\nTracking: ${tracking_number}`.trim();
    }

    const { data, error } = await supabase
      .from('exchanges')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error marking exchange as shipped:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Exchange shipped: ${id}`);
    res.json({
      message: 'Exchange marked as shipped',
      exchange: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /exchanges/:id/complete
 * Mark exchange as completed
 */
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { completed_by, notes } = req.body;

    const { data, error } = await supabase
      .from('exchanges')
      .update({
        status: 'completed',
        resolved_by: completed_by,
        resolution_details: notes,
        resolved_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error completing exchange:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Exchange completed: ${id}`);
    res.json({
      message: 'Exchange marked as completed',
      exchange: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /exchanges/stats
 * Get exchange statistics for a brand
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const { brand_id } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const { data, error } = await supabase
      .from('exchanges')
      .select('status, exchange_reason')
      .eq('brand_id', brand_id);

    if (error) {
      console.error('❌ Error fetching exchange stats:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Calculate statistics
    const stats = {
      total: data.length,
      by_status: {
        pending: data.filter(e => e.status === 'pending').length,
        approved: data.filter(e => e.status === 'approved').length,
        shipped: data.filter(e => e.status === 'shipped').length,
        completed: data.filter(e => e.status === 'completed').length,
        rejected: data.filter(e => e.status === 'rejected').length,
        closed: data.filter(e => e.status === 'closed').length
      },
      by_reason: {
        size_issue: data.filter(e => e.exchange_reason === 'size_issue').length,
        defective: data.filter(e => e.exchange_reason === 'defective').length,
        damaged: data.filter(e => e.exchange_reason === 'damaged').length,
        wrong_item: data.filter(e => e.exchange_reason === 'wrong_item').length,
        other: data.filter(e => e.exchange_reason === 'other').length
      }
    };

    res.json(stats);
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
