const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { sendDM } = require('../lib/meta');

/**
 * GET /conversations
 * List all conversations for the authenticated user's brand.
 * Query params:
 *   - status: 'all' | 'active' | 'escalated' | 'resolved' | 'archived' (default: 'all')
 *   - limit: number (default 50)
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { status = 'all', limit = 50 } = req.query;

    // Get brand_id for this user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const brand_id = user.brand_id;

    // Fetch conversations with last message via subquery
    let query = supabase
      .from('conversations')
      .select(`
        id,
        customer_id,
        customer_name,
        customer_username,
        platform,
        status,
        is_escalated,
        escalation_type,
        escalation_reason,
        escalated_at,
        metadata,
        created_at,
        updated_at,
        messages (
          id,
          sender,
          content,
          created_at
        )
      `)
      .eq('brand_id', brand_id)
      .order('updated_at', { ascending: false })
      .limit(parseInt(limit));

    // Filter by status
    if (status === 'escalated') {
      query = query.eq('is_escalated', true);
    } else if (status === 'resolved') {
      query = query.eq('status', 'resolved');
    } else if (status === 'pending' || status === 'active') {
      query = query.eq('status', 'active').eq('is_escalated', false);
    }
    // 'all' applies no filter

    const { data: conversations, error } = await query;

    if (error) {
      console.error('❌ Error fetching conversations:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Shape the response for the frontend
    const shaped = (conversations || []).map((conv) => {
      const msgs = conv.messages || [];
      // Sort messages by created_at ascending to get the last one
      msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const lastMsg = msgs[msgs.length - 1];

      // Determine frontend status
      let frontendStatus = 'pending';
      if (conv.is_escalated) frontendStatus = 'escalated';
      else if (conv.status === 'resolved') frontendStatus = 'resolved';
      else if (conv.status === 'active') frontendStatus = 'pending';

      // Unread count: messages from 'customer' that are at the end (simple heuristic)
      let unread_count = 0;
      if (lastMsg && lastMsg.sender === 'customer') {
        // Count trailing customer messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].sender === 'customer') unread_count++;
          else break;
        }
      }

      // Display name priority: Instagram name > metadata collected name > customer_id
      const displayName = conv.customer_name
        || conv.metadata?.collected_info?.name
        || conv.customer_id;
      const displayUsername = conv.customer_username
        ? `@${conv.customer_username}`
        : `@${conv.customer_id}`;

      return {
        id: conv.id,
        customer_id: conv.customer_id,
        customer_name: displayName,
        customer_username: conv.customer_username || null,
        handle: displayUsername,
        platform: conv.platform === 'shopify' ? 'shopify' : 'instagram',
        status: frontendStatus,
        is_escalated: conv.is_escalated,
        escalation_type: conv.escalation_type,
        escalation_reason: conv.escalation_reason,
        last_message: lastMsg ? lastMsg.content : '',
        timestamp: lastMsg ? lastMsg.created_at : conv.created_at,
        luna_enabled: !conv.is_escalated && conv.status === 'active',
        unread_count,
        message_count: msgs.length,
      };
    });

    res.json({ conversations: shaped, count: shaped.length });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /conversations/:id
 * Get a single conversation with all its messages.
 */
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { id } = req.params;

    // Get brand_id for this user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: conv, error } = await supabase
      .from('conversations')
      .select(`
        id,
        customer_id,
        customer_name,
        customer_username,
        platform,
        status,
        is_escalated,
        escalation_type,
        escalation_reason,
        escalated_at,
        metadata,
        created_at,
        updated_at,
        messages (
          id,
          sender,
          content,
          image_url,
          created_at
        )
      `)
      .eq('id', id)
      .eq('brand_id', user.brand_id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Sort messages ascending
    const msgs = (conv.messages || []).sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    // Map sender to frontend 'from' field
    const mappedMessages = msgs.map((m) => ({
      id: m.id,
      from: m.sender === 'ai' ? 'luna' : m.sender === 'human' ? 'agent' : 'customer',
      text: m.content,
      image_url: m.image_url || null,
      time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      created_at: m.created_at,
    }));

    const displayName = conv.customer_name
      || conv.metadata?.collected_info?.name
      || conv.customer_id;
    const displayUsername = conv.customer_username
      ? `@${conv.customer_username}`
      : `@${conv.customer_id}`;

    res.json({
      conversation: {
        id: conv.id,
        customer_id: conv.customer_id,
        customer_name: displayName,
        customer_username: conv.customer_username || null,
        handle: displayUsername,
        platform: conv.platform,
        status: conv.is_escalated ? 'escalated' : conv.status === 'resolved' ? 'resolved' : 'pending',
        is_escalated: conv.is_escalated,
        escalation_type: conv.escalation_type,
        escalation_reason: conv.escalation_reason,
        luna_enabled: !conv.is_escalated && conv.status === 'active',
        metadata: conv.metadata,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      },
      messages: mappedMessages,
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /conversations/:id/messages
 * Send a manual message from the human agent to the customer.
 * Body: { content: string }
 */
router.post('/:id/messages', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    // Verify ownership
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: conv, error: convError } = await supabase
      .from('conversations')
      .select('id, brand_id, customer_id, platform, status')
      .eq('id', id)
      .eq('brand_id', user.brand_id)
      .single();

    if (convError || !conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Insert message
    const { data: newMessage, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: id,
        sender: 'human',
        content: content.trim(),
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (msgError) {
      console.error('❌ Error inserting message:', msgError.message);
      return res.status(500).json({ error: 'Failed to send message' });
    }

    // Update conversation updated_at
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    // Send the message to Instagram — use same lookup pattern as the AI webhook
    if (conv.platform === 'instagram') {
      console.log(`📤 Attempting to send agent DM to Instagram user ${conv.customer_id} (brand: ${conv.brand_id})`);

      const { data: integration, error: integError } = await supabase
        .from('integrations')
        .select('access_token, instagram_page_id')
        .eq('brand_id', conv.brand_id)
        .maybeSingle();

      if (integError) {
        console.error('❌ Integration query error:', integError.message);
      } else if (!integration) {
        console.error('❌ No integration row found for brand_id:', conv.brand_id);
      } else if (!integration.access_token) {
        console.error('❌ Integration found but access_token is empty for brand_id:', conv.brand_id);
      } else {
        console.log(`🔑 Using token for page ${integration.instagram_page_id}: ${integration.access_token.substring(0, 15)}...`);
        try {
          await sendDM(conv.customer_id, content.trim(), integration.access_token);
          console.log(`✅ Agent DM delivered to Instagram user ${conv.customer_id}`);
        } catch (dmErr) {
          console.error('❌ sendDM failed:', dmErr.message);
          // Message is already saved to DB — don't fail the HTTP response
        }
      }
    }

    console.log(`✅ Agent message saved to conversation ${id}`);

    res.status(201).json({
      message: {
        id: newMessage.id,
        from: 'agent',
        text: newMessage.content,
        time: new Date(newMessage.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        created_at: newMessage.created_at,
      },
    });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /conversations/:id
 * Update conversation status.
 * Body: { status: 'active' | 'resolved' | 'archived' }
 */
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { id } = req.params;
    const { status } = req.body;

    const VALID_STATUSES = ['active', 'resolved', 'archived'];
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data, error } = await supabase
      .from('conversations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('brand_id', user.brand_id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true, conversation: data });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /conversations/:id/handover
 * Agent takes over the conversation — disables Luna (sets is_escalated=true with escalated_by='human').
 * Body: {} (empty)
 */
router.post('/:id/handover', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { id } = req.params;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data, error } = await supabase
      .from('conversations')
      .update({
        is_escalated: true,
        escalation_type: 'general',
        escalation_reason: 'Agent manually took over the conversation',
        escalated_at: new Date().toISOString(),
        escalated_by: 'human',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('brand_id', user.brand_id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Insert system message indicating handover
    await supabase.from('messages').insert({
      conversation_id: id,
      sender: 'human',
      content: '[Agent has taken over this conversation]',
      created_at: new Date().toISOString(),
    });

    console.log(`✅ Handover: agent took over conversation ${id}`);
    res.json({ success: true, luna_enabled: false });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /conversations/:id/restore-luna
 * Re-enable Luna for a conversation (undo handover).
 * Body: {} (empty)
 */
router.post('/:id/restore-luna', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { id } = req.params;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data, error } = await supabase
      .from('conversations')
      .update({
        is_escalated: false,
        escalation_type: null,
        escalation_reason: null,
        escalated_at: null,
        escalated_by: 'ai',
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('brand_id', user.brand_id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    console.log(`✅ Luna restored for conversation ${id}`);
    res.json({ success: true, luna_enabled: true });
  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /conversations/:id/reset-metadata
 * Reset conversation metadata for testing.
 */
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
          awaiting: null,
        },
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to reset metadata', details: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true, message: 'Metadata reset successfully', metadata: data.metadata });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset metadata', details: error.message });
  }
});

module.exports = router;
