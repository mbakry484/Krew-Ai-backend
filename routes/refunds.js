const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

/**
 * GET /refunds
 * Fetch all refunds for a brand
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
      .from('refunds')
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
      console.error('❌ Error fetching refunds:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      refunds: data,
      count: data.length
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /refunds/pending
 * Fetch all pending refunds using the view
 */
router.get('/pending', async (req, res) => {
  try {
    const { brand_id } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const { data, error } = await supabase
      .from('pending_refunds')
      .select('*')
      .eq('brand_id', brand_id);

    if (error) {
      console.error('❌ Error fetching pending refunds:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      pending_refunds: data,
      count: data.length
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /refunds/:id
 * Get a specific refund by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('refunds')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('❌ Error fetching refund:', error.message);
      return res.status(404).json({ error: 'Refund not found' });
    }

    res.json({ refund: data });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /refunds
 * Create a new refund request
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
      original_order_number,
      product_name,
      product_sku,
      order_amount,
      refund_amount,
      refund_reason,
      refund_reason_details,
      evidence_images
    } = req.body;

    // Validation
    if (!brand_id || !customer_id || !product_name || !refund_reason) {
      return res.status(400).json({
        error: 'Missing required fields: brand_id, customer_id, product_name, refund_reason'
      });
    }

    const { data, error } = await supabase
      .from('refunds')
      .insert({
        brand_id,
        conversation_id,
        order_id,
        customer_id,
        customer_name,
        customer_phone,
        original_order_number,
        product_name,
        product_sku,
        order_amount,
        refund_amount: refund_amount || order_amount, // Default to full refund
        refund_reason,
        refund_reason_details,
        evidence_images: evidence_images || [],
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating refund:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Refund request created: ${data.id}`);
    res.status(201).json({
      message: 'Refund request created successfully',
      refund: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /refunds/:id
 * Update refund status or details
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      refund_amount,
      refund_method,
      bank_account_details,
      transaction_id,
      internal_notes,
      resolved_by,
      resolution_details,
      rejection_reason
    } = req.body;

    const updateData = {};

    if (status) updateData.status = status;
    if (refund_amount !== undefined) updateData.refund_amount = refund_amount;
    if (refund_method) updateData.refund_method = refund_method;
    if (bank_account_details) updateData.bank_account_details = bank_account_details;
    if (transaction_id) updateData.transaction_id = transaction_id;
    if (internal_notes) updateData.internal_notes = internal_notes;
    if (resolved_by) updateData.resolved_by = resolved_by;
    if (resolution_details) updateData.resolution_details = resolution_details;
    if (rejection_reason) updateData.rejection_reason = rejection_reason;

    // If status is completed or closed, set resolved_at
    if (status && ['completed', 'closed'].includes(status)) {
      updateData.resolved_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('refunds')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating refund:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Refund updated: ${id} - Status: ${status || 'unchanged'}`);
    res.json({
      message: 'Refund updated successfully',
      refund: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /refunds/:id/approve
 * Approve a refund request
 */
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approved_by, notes, refund_amount } = req.body;

    const updateData = {
      status: 'approved',
      resolved_by: approved_by,
      internal_notes: notes
    };

    if (refund_amount !== undefined) {
      updateData.refund_amount = refund_amount;
    }

    const { data, error } = await supabase
      .from('refunds')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error approving refund:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Refund approved: ${id} by ${approved_by}`);
    res.json({
      message: 'Refund approved successfully',
      refund: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /refunds/:id/reject
 * Reject a refund request
 */
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { rejected_by, reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const { data, error } = await supabase
      .from('refunds')
      .update({
        status: 'rejected',
        resolved_by: rejected_by,
        rejection_reason: reason,
        resolved_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error rejecting refund:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Refund rejected: ${id}`);
    res.json({
      message: 'Refund rejected',
      refund: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /refunds/:id/complete
 * Mark refund as completed
 */
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id, refund_method, completed_by, notes } = req.body;

    const { data, error } = await supabase
      .from('refunds')
      .update({
        status: 'completed',
        transaction_id,
        refund_method,
        resolved_by: completed_by,
        resolution_details: notes,
        resolved_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error completing refund:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Refund completed: ${id}`);
    res.json({
      message: 'Refund marked as completed',
      refund: data
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /refunds/stats
 * Get refund statistics for a brand
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const { brand_id } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const { data, error } = await supabase
      .from('refunds')
      .select('status, refund_amount, refund_reason')
      .eq('brand_id', brand_id);

    if (error) {
      console.error('❌ Error fetching refund stats:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Calculate statistics
    const stats = {
      total: data.length,
      by_status: {
        pending: data.filter(r => r.status === 'pending').length,
        approved: data.filter(r => r.status === 'approved').length,
        processed: data.filter(r => r.status === 'processed').length,
        completed: data.filter(r => r.status === 'completed').length,
        rejected: data.filter(r => r.status === 'rejected').length,
        closed: data.filter(r => r.status === 'closed').length
      },
      by_reason: {
        defective: data.filter(r => r.refund_reason === 'defective').length,
        damaged: data.filter(r => r.refund_reason === 'damaged').length,
        not_as_described: data.filter(r => r.refund_reason === 'not_as_described').length,
        delivery_issue: data.filter(r => r.refund_reason === 'delivery_issue').length,
        other: data.filter(r => r.refund_reason === 'other').length
      },
      total_amount: data.reduce((sum, r) => sum + (parseFloat(r.refund_amount) || 0), 0)
    };

    res.json(stats);
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
