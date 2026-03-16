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

  try {
    // Check if this is a message event
    if (body.object === 'instagram') {
      for (const entry of body.entry) {
        for (const messagingEvent of entry.messaging) {
          // Extract sender and recipient IDs
          const senderId = messagingEvent.sender?.id;
          const recipientId = messagingEvent.recipient?.id;

          // Ignore messages sent by the page itself (avoid reply loops)
          if (senderId === recipientId) {
            console.log('Ignoring message sent by page itself');
            continue;
          }

          // Only process incoming messages (not echoes)
          if (messagingEvent.message && !messagingEvent.message.is_echo) {
            await handleIncomingMessage(messagingEvent, recipientId);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
  } finally {
    // Always return 200 regardless of errors
    res.sendStatus(200);
  }
});

/**
 * Handle an incoming Instagram DM
 */
async function handleIncomingMessage(messagingEvent, recipientId) {
  const senderId = messagingEvent.sender.id;
  const messageText = messagingEvent.message.text;
  const messageId = messagingEvent.message.mid;

  console.log(`Received message from ${senderId}: ${messageText}`);

  try {
    // 1. Look up the brand using recipient.id (Instagram page ID)
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id, access_token')
      .eq('instagram_page_id', recipientId)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (integrationError || !integration || !integration.brand_id) {
      console.error('Brand not found for Instagram page:', recipientId);
      return;
    }

    const { brand_id, access_token } = integration;

    // 2. Fetch knowledge base for the brand
    const { data: knowledgeBaseRows, error: kbError } = await supabase
      .from('knowledge_base')
      .select('question, answer')
      .eq('brand_id', brand_id);

    if (kbError) {
      console.error('Error fetching knowledge base:', kbError);
    }

    // 3. Fetch products for the brand
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('name, description, price, in_stock')
      .eq('brand_id', brand_id);

    if (productsError) {
      console.error('Error fetching products:', productsError);
    }

    // 4. Get or create conversation (upsert)
    const { data: conversation, error: convUpsertError } = await supabase
      .from('conversations')
      .upsert({
        brand_id,
        instagram_thread_id: senderId,
        customer_instagram_id: senderId,
        platform: 'instagram',
        status: 'active',
      }, {
        onConflict: 'brand_id,customer_instagram_id',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (convUpsertError) {
      console.error('Error upserting conversation:', convUpsertError);
      return;
    }

    // 5. Save incoming message
    const { error: inboundMsgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'customer',
        content: messageText,
        platform_message_id: messageId,
      });

    if (inboundMsgError) {
      console.error('Error saving inbound message:', inboundMsgError);
    }

    // 6. Generate AI reply using OpenAI
    const aiReply = await generateReply(
      messageText,
      knowledgeBaseRows || [],
      products || [],
      brand_id
    );

    // 7. Send reply via Meta API
    const sendResponse = await sendDM(senderId, aiReply, access_token);

    // 8. Save AI reply to database
    const { error: outboundMsgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'ai',
        content: aiReply,
        platform_message_id: sendResponse.message_id,
      });

    if (outboundMsgError) {
      console.error('Error saving outbound message:', outboundMsgError);
    }

    console.log(`✅ Sent AI reply to ${senderId}`);
  } catch (error) {
    console.error('Error handling message:', error);

    // Send fallback message
    try {
      const { data: integration } = await supabase
        .from('integrations')
        .select('access_token')
        .eq('instagram_page_id', recipientId)
        .eq('platform', 'instagram')
        .maybeSingle();

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
