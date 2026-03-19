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

  console.log(`\n${'='.repeat(80)}`);
  console.log(`📥 WEBHOOK RECEIVED - ${new Date().toISOString()}`);
  console.log(`Object type: ${body.object}`);
  console.log(`Number of entries: ${body.entry?.length || 0}`);

  // Detailed webhook structure logging
  console.log('\n🔍 Full webhook body:', JSON.stringify(body, null, 2));

  try {
    // Check if this is a message event (can be 'instagram' or 'page')
    if (body.object === 'instagram' || body.object === 'page') {
      console.log(`✅ Valid webhook object type: ${body.object}`);

      for (const entry of body.entry) {
        console.log(`\n📦 Processing entry ID: ${entry.id}`);
        console.log(`   Messaging events: ${entry.messaging?.length || 0}`);

        for (const messagingEvent of entry.messaging || []) {
          // Extract sender and recipient IDs
          const senderId = messagingEvent.sender?.id;
          const recipientId = messagingEvent.recipient?.id;

          console.log('\n📌 ID ANALYSIS:');
          console.log(`   Object type: ${body.object}`);
          console.log(`   Entry ID: ${entry.id}`);
          console.log(`   Sender ID: ${senderId}`);
          console.log(`   Recipient ID: ${recipientId}`);
          console.log(`   👤 Sender: ${senderId}`);
          console.log(`   📍 Recipient: ${recipientId}`);
          console.log(`   📝 Has message: ${!!messagingEvent.message}`);
          console.log(`   🔁 Is echo: ${messagingEvent.message?.is_echo || false}`);

          // Ignore messages sent by the page itself (avoid reply loops)
          if (senderId === recipientId) {
            console.log('   ⏭️  Ignoring message sent by page itself');
            continue;
          }

          // Only process incoming messages (not echoes)
          if (messagingEvent.message && !messagingEvent.message.is_echo) {
            console.log(`   ✅ Processing message: "${messagingEvent.message.text}"`);
            await handleIncomingMessage(messagingEvent, recipientId);
          } else {
            console.log(`   ⏭️  Skipping (echo or no message)`);
          }
        }
      }
    } else {
      console.log(`⚠️  Unknown webhook object type: ${body.object}`);
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    // Always return 200 regardless of errors
    console.log(`\n✅ Responding with 200 OK`);
    console.log(`${'='.repeat(80)}\n`);
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

  console.log(`\n📨 Received message from ${senderId}: ${messageText}`);
  console.log(`   Recipient ID being used for lookup: ${recipientId}`);

  try {
    // 1. Look up the brand using recipient.id
    console.log('\n🔍 INTEGRATION LOOKUP:');
    console.log(`   Searching for instagram_page_id = ${recipientId}`);
    console.log(`   Platform = 'instagram'`);
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id, access_token')
      .eq('instagram_page_id', recipientId)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (integrationError) {
      console.error('❌ Error fetching integration:', integrationError);
      return;
    }

    if (!integration) {
      console.error('❌ No integration found for page:', recipientId);
      console.error('   Make sure you have a row in integrations table with:');
      console.error('   - instagram_page_id =', recipientId);
      console.error('   - platform = \'instagram\'');
      return;
    }

    if (!integration.brand_id) {
      console.error('❌ Integration found but brand_id is NULL!');
      console.error('   Update the integrations table to set brand_id');
      return;
    }

    console.log(`✅ Integration found - brand_id: ${integration.brand_id}`);

    const { brand_id, access_token } = integration;

    // 2. Fetch knowledge base for the brand
    console.log(`📚 Fetching knowledge base for brand: ${brand_id}`);
    const { data: knowledgeBaseRows, error: kbError } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brand_id);

    if (kbError) {
      console.error('❌ Error fetching knowledge base:', kbError);
      console.error('   This is OK - AI will work without knowledge base');
    } else {
      console.log(`✅ Knowledge base: ${knowledgeBaseRows?.length || 0} entries`);
    }

    // 3. Fetch products for the brand
    console.log(`🛍️  Fetching products for brand: ${brand_id}`);
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('name, description, price, in_stock')
      .eq('brand_id', brand_id);

    if (productsError) {
      console.error('❌ Error fetching products:', productsError);
    } else {
      console.log(`✅ Products: ${products?.length || 0} items`);
    }

    // 4. Get or create conversation
    console.log(`💬 Looking for existing conversation...`);
    let { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('*')
      .eq('brand_id', brand_id)
      .eq('customer_id', senderId)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (convError) {
      console.error('❌ Error fetching conversation:', convError);
    }

    if (!conversation) {
      console.log(`📝 Creating new conversation...`);
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
        console.error('❌ Error creating conversation:', createError);
        return;
      }
      conversation = newConv;
      console.log(`✅ Conversation created - ID: ${conversation.id}`);
    } else {
      console.log(`✅ Existing conversation found - ID: ${conversation.id}`);
    }

    // 5. Fetch conversation history (last 10 messages)
    console.log(`📜 Fetching conversation history...`);
    const { data: previousMessages, error: historyError } = await supabase
      .from('messages')
      .select('sender, content')
      .eq('conversation_id', conversation.id)
      .order('sent_at', { ascending: true })
      .limit(10);

    if (historyError) {
      console.error('❌ Error fetching conversation history:', historyError);
    } else {
      console.log(`✅ Conversation history: ${previousMessages?.length || 0} messages`);
    }

    // 6. Save incoming message
    console.log(`💾 Saving customer message to database...`);
    const { error: inboundMsgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'customer',
        content: messageText,
        platform_message_id: messageId,
      });

    if (inboundMsgError) {
      console.error('❌ Error saving inbound message:', inboundMsgError);
    } else {
      console.log(`✅ Customer message saved`);
    }

    // 7. Map conversation history to OpenAI message format
    console.log(`🔄 Mapping conversation history to OpenAI format...`);
    const conversationHistory = (previousMessages || []).map(msg => ({
      role: msg.sender === 'customer' ? 'user' : 'assistant',
      content: msg.content
    }));
    console.log(`✅ Conversation history mapped: ${conversationHistory.length} messages`);

    // 8. Generate AI reply using OpenAI with conversation history
    console.log(`🤖 Generating AI reply with conversation context...`);
    const aiReply = await generateReply(
      messageText,
      knowledgeBaseRows || [],
      products || [],
      brand_id,
      conversationHistory
    );
    console.log(`✅ AI reply generated: "${aiReply.substring(0, 100)}${aiReply.length > 100 ? '...' : ''}"`);

    // 9. Send reply via Meta API
    console.log(`📤 Sending reply to customer via Meta API...`);
    const sendResponse = await sendDM(senderId, aiReply, access_token);
    console.log(`✅ Reply sent successfully via Meta API`);

    // 10. Save AI reply to database
    console.log(`💾 Saving AI message to database...`);
    const { error: outboundMsgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'ai',
        content: aiReply,
        platform_message_id: sendResponse.message_id,
      });

    if (outboundMsgError) {
      console.error('❌ Error saving outbound message:', outboundMsgError);
    } else {
      console.log(`✅ AI message saved to database`);
    }

    console.log(`\n🎉 SUCCESS! AI reply sent to ${senderId}`);
  } catch (error) {
    console.error('\n❌ ERROR HANDLING MESSAGE:');
    console.error('   Error type:', error.name);
    console.error('   Error message:', error.message);

    if (error.message.includes('Connection error') || error.message.includes('API key')) {
      console.error('   ⚠️  This looks like an OpenAI API issue!');
      console.error('   Check your OPENAI_API_KEY environment variable');
    }

    console.error('   Stack trace:', error.stack);

    // Send fallback message
    try {
      console.log('\n📤 Attempting to send fallback message...');
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
        console.log('✅ Fallback message sent successfully');
      } else {
        console.error('❌ Could not send fallback - no access token found');
      }
    } catch (fallbackError) {
      console.error('❌ Error sending fallback message:', fallbackError.message);
    }
  }
}

module.exports = router;
