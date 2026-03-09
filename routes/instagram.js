const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { generateReply } = require('../lib/claude');
const { sendDM } = require('../lib/meta');

/**
 * GET /webhook/instagram - Webhook verification
 * Meta calls this endpoint to verify the webhook
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed');
    res.sendStatus(403);
  }
});

/**
 * POST /webhook/instagram - Receive incoming DMs
 * Meta sends DM events to this endpoint
 */
router.post('/', async (req, res) => {
  const body = req.body;

  // Acknowledge receipt immediately
  res.sendStatus(200);

  try {
    // Check if this is a message event
    if (body.object === 'instagram') {
      for (const entry of body.entry) {
        for (const messagingEvent of entry.messaging) {
          // Only process incoming messages (not echoes)
          if (messagingEvent.message && !messagingEvent.message.is_echo) {
            await handleIncomingMessage(messagingEvent, entry.id);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
  }
});

/**
 * Handle an incoming Instagram DM
 */
async function handleIncomingMessage(messagingEvent, pageId) {
  const senderId = messagingEvent.sender.id;
  const messageText = messagingEvent.message.text;
  const messageId = messagingEvent.message.mid;

  console.log(`Received message from ${senderId}: ${messageText}`);

  try {
    // 1. Identify the brand from integrations table using pageId
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id, access_token')
      .eq('instagram_page_id', pageId)
      .single();

    if (integrationError || !integration) {
      console.error('Brand not found for page:', pageId);
      return;
    }

    const { brand_id, access_token } = integration;

    // 2. Fetch knowledge base for the brand
    const { data: knowledgeBase, error: kbError } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brand_id)
      .single();

    if (kbError) {
      console.error('Error fetching knowledge base:', kbError);
    }

    // 3. Fetch products for the brand
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('*')
      .eq('brand_id', brand_id);

    if (productsError) {
      console.error('Error fetching products:', productsError);
    }

    // 4. Get or create conversation
    let { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('brand_id', brand_id)
      .eq('customer_id', senderId)
      .eq('platform', 'instagram')
      .single();

    if (convError || !conversation) {
      // Create new conversation
      const { data: newConv, error: createError } = await supabase
        .from('conversations')
        .insert({
          brand_id,
          customer_id: senderId,
          platform: 'instagram',
          status: 'active',
        })
        .select()
        .single();

      if (createError) {
        console.error('Error creating conversation:', createError);
        return;
      }
      conversation = newConv;
    }

    // 5. Save incoming message
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      sender: 'customer',
      content: messageText,
      platform_message_id: messageId,
    });

    // 6. Generate AI reply using Claude
    const aiReply = await generateReply(
      messageText,
      knowledgeBase,
      products || []
    );

    // 7. Send reply via Meta API
    const sendResponse = await sendDM(senderId, aiReply, access_token);

    // 8. Save AI reply to database
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      sender: 'ai',
      content: aiReply,
      platform_message_id: sendResponse.message_id,
    });

    console.log(`Sent AI reply to ${senderId}`);
  } catch (error) {
    console.error('Error handling message:', error);

    // Send fallback message
    try {
      const { data: integration } = await supabase
        .from('integrations')
        .select('access_token')
        .eq('instagram_page_id', pageId)
        .single();

      if (integration?.access_token) {
        await sendDM(
          senderId,
          "Sorry, I'm having trouble processing your message right now. Please try again later or contact our support team.",
          integration.access_token
        );
      }
    } catch (fallbackError) {
      console.error('Error sending fallback message:', fallbackError);
    }
  }
}

module.exports = router;
