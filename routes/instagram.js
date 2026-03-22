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
          metadata: {
            discussed_products: [],
            current_order: null,
            collected_info: {
              name: null,
              phone: null,
              address: null
            },
            awaiting: null
          }
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

    // Step 1: Load conversation metadata
    console.log(`📊 Loading conversation metadata...`);
    let metadata = conversation.metadata || {
      discussed_products: [],
      current_order: null,
      collected_info: {
        name: null,
        phone: null,
        address: null
      },
      awaiting: null
    };
    console.log(`✅ Metadata loaded:`, JSON.stringify(metadata, null, 2));

    // 5. Fetch conversation history (last 10 messages)
    console.log(`📜 Fetching conversation history...`);
    const { data: previousMessages, error: historyError } = await supabase
      .from('messages')
      .select('sender, content')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
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

    // 8. Fetch business name for system prompt
    console.log(`🏢 Fetching business name for brand: ${brand_id}`);
    let businessName = 'our business';
    const { data: user } = await supabase
      .from('users')
      .select('business_name')
      .eq('id', brand_id)
      .maybeSingle();

    if (user?.business_name) {
      businessName = user.business_name;
      console.log(`✅ Business name: ${businessName}`);
    } else {
      console.log(`⚠️  Business name not found, using default`);
    }

    // 9. Generate AI reply using OpenAI with conversation history and metadata
    console.log(`🤖 Generating AI reply with conversation context and order state...`);
    const aiReply = await generateReply(
      messageText,
      knowledgeBaseRows || [],
      products || [],
      brand_id,
      conversationHistory,
      metadata,
      businessName
    );
    console.log(`✅ AI reply generated: "${aiReply.substring(0, 100)}${aiReply.length > 100 ? '...' : ''}"`);

    // 10. Parse and update metadata based on AI reply and customer message
    console.log(`🔄 Parsing conversation to update metadata...`);
    metadata = await updateMetadataFromConversation(
      messageText,
      aiReply,
      metadata,
      products || [],
      previousMessages || []
    );
    console.log(`✅ Metadata updated:`, JSON.stringify(metadata, null, 2));

    // 11. Check if ORDER_READY was detected
    let finalReply = aiReply;
    if (aiReply.includes('ORDER_READY')) {
      console.log(`🎉 ORDER_READY detected! Creating Shopify order...`);
      finalReply = await handleOrderCreation(brand_id, metadata, aiReply);

      // Reset order state after successful order
      metadata.current_order = null;
      metadata.collected_info = { name: null, phone: null, address: null };
      metadata.awaiting = null;
      console.log(`✅ Order state reset`);
    }

    // 12. Send reply via Meta API
    console.log(`📤 Sending reply to customer via Meta API...`);
    const sendResponse = await sendDM(senderId, finalReply, access_token);
    console.log(`✅ Reply sent successfully via Meta API`);

    // 13. Save AI reply to database
    console.log(`💾 Saving AI message to database...`);
    const { error: outboundMsgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'ai',
        content: finalReply,
        platform_message_id: sendResponse.message_id,
      });

    if (outboundMsgError) {
      console.error('❌ Error saving outbound message:', outboundMsgError);
    } else {
      console.log(`✅ AI message saved to database`);
    }

    // 14. Save updated metadata to conversation
    console.log(`💾 Saving updated metadata to conversation...`);
    const { error: metadataError } = await supabase
      .from('conversations')
      .update({ metadata })
      .eq('id', conversation.id);

    if (metadataError) {
      console.error('❌ Error saving metadata:', metadataError);
    } else {
      console.log(`✅ Metadata saved to database`);
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

/**
 * Update metadata based on conversation flow
 * Tracks discussed products, order state, and customer info
 */
async function updateMetadataFromConversation(customerMessage, aiReply, metadata, products, conversationHistory) {
  try {
    // Extract product mentions from conversation
    const productMentions = extractProductMentions(
      customerMessage,
      aiReply,
      products,
      conversationHistory
    );

    // Add newly mentioned products to discussed_products
    productMentions.forEach(product => {
      const alreadyDiscussed = metadata.discussed_products.find(
        p => p.product_id === product.product_id
      );
      if (!alreadyDiscussed) {
        metadata.discussed_products.push({
          index: metadata.discussed_products.length + 1,
          ...product
        });
      }
    });

    // Update collected_info based on awaiting state
    if (metadata.awaiting === 'name') {
      // Customer just provided their name
      metadata.collected_info.name = customerMessage.trim();
      console.log(`   📝 Captured name: ${metadata.collected_info.name}`);
    } else if (metadata.awaiting === 'phone') {
      // Customer just provided their phone
      metadata.collected_info.phone = customerMessage.trim();
      console.log(`   📱 Captured phone: ${metadata.collected_info.phone}`);
    } else if (metadata.awaiting === 'address') {
      // Customer just provided their address
      metadata.collected_info.address = customerMessage.trim();
      console.log(`   📍 Captured address: ${metadata.collected_info.address}`);
    }

    // Detect what Luna is currently asking for
    metadata.awaiting = detectAwaitingState(aiReply, metadata);
    console.log(`   ⏳ Now awaiting: ${metadata.awaiting || 'nothing'}`);

    // Detect if ordering a product
    if (!metadata.current_order && detectOrderIntent(customerMessage, aiReply)) {
      // Try to identify which product they want to order
      const orderedProduct = identifyOrderedProduct(
        customerMessage,
        aiReply,
        metadata.discussed_products,
        products
      );
      if (orderedProduct) {
        metadata.current_order = orderedProduct;
        console.log(`   🛒 Current order set:`, orderedProduct);
      }
    }

    return metadata;
  } catch (error) {
    console.error('❌ Error updating metadata:', error);
    return metadata; // Return unchanged on error
  }
}

/**
 * Extract product mentions from conversation
 */
function extractProductMentions(customerMessage, aiReply, products, conversationHistory) {
  const mentions = [];
  const lowerCaseReply = aiReply.toLowerCase();

  products.forEach(product => {
    const productNameLower = product.name.toLowerCase();
    // Check if product is mentioned in AI reply
    if (lowerCaseReply.includes(productNameLower)) {
      mentions.push({
        name: product.name,
        product_id: product.id,
        variant_id: product.shopify_product_id || null,
        price: product.price
      });
    }
  });

  return mentions;
}

/**
 * Detect what information Luna is currently asking for
 */
function detectAwaitingState(aiReply, metadata) {
  const lowerReply = aiReply.toLowerCase();

  // Check for confirmation state (all info collected)
  if (metadata.collected_info.name &&
      metadata.collected_info.phone &&
      metadata.collected_info.address &&
      (lowerReply.includes('confirm') || lowerReply.includes('تأكيد') || lowerReply.includes('ta2kid'))) {
    return 'confirmation';
  }

  // Check what's being asked
  if ((lowerReply.includes('name') || lowerReply.includes('اسم') || lowerReply.includes('ism')) &&
      !metadata.collected_info.name) {
    return 'name';
  }

  if ((lowerReply.includes('phone') || lowerReply.includes('number') || lowerReply.includes('رقم') || lowerReply.includes('ra2m')) &&
      !metadata.collected_info.phone) {
    return 'phone';
  }

  if ((lowerReply.includes('address') || lowerReply.includes('location') || lowerReply.includes('عنوان') || lowerReply.includes('3onwan')) &&
      !metadata.collected_info.address) {
    return 'address';
  }

  return null;
}

/**
 * Detect if customer wants to place an order
 */
function detectOrderIntent(customerMessage, aiReply) {
  const lowerMsg = customerMessage.toLowerCase();
  const orderKeywords = [
    'order', 'buy', 'purchase', 'take', 'want',
    '3ayez', '3ayz', 'عايز', 'بدي', 'خد', 'اشتري'
  ];

  return orderKeywords.some(keyword => lowerMsg.includes(keyword));
}

/**
 * Identify which product the customer wants to order
 */
function identifyOrderedProduct(customerMessage, aiReply, discussedProducts, allProducts) {
  const lowerMsg = customerMessage.toLowerCase();

  // Check if customer references by number (e.g., "the first one", "number 2", "الأول")
  const numberMatch = lowerMsg.match(/\b(first|1st|one|الأول|awel)\b/i);
  if (numberMatch && discussedProducts.length > 0) {
    const product = discussedProducts[0];
    return {
      product_name: product.name,
      product_id: product.product_id,
      variant_id: product.variant_id,
      price: product.price
    };
  }

  // Check if customer mentions a specific product name
  for (const product of discussedProducts) {
    if (lowerMsg.includes(product.name.toLowerCase())) {
      return {
        product_name: product.name,
        product_id: product.product_id,
        variant_id: product.variant_id,
        price: product.price
      };
    }
  }

  // If only one product discussed, assume that's what they want
  if (discussedProducts.length === 1) {
    const product = discussedProducts[0];
    return {
      product_name: product.name,
      product_id: product.product_id,
      variant_id: product.variant_id,
      price: product.price
    };
  }

  return null;
}

/**
 * Handle order creation when ORDER_READY is detected
 */
async function handleOrderCreation(brandId, metadata, aiReply) {
  try {
    const { createShopifyOrder } = require('../lib/shopify');

    // Validate order data
    if (!metadata.current_order) {
      console.error('❌ No current_order in metadata');
      return aiReply.replace('ORDER_READY',
        '⚠️ There was an issue processing your order. Please try again or contact our team.');
    }

    if (!metadata.collected_info.name ||
        !metadata.collected_info.phone ||
        !metadata.collected_info.address) {
      console.error('❌ Missing customer information');
      return aiReply.replace('ORDER_READY',
        '⚠️ We need a bit more information to complete your order. Please provide your full details.');
    }

    // Fetch Shopify integration
    console.log(`   🔍 Fetching Shopify integration for brand: ${brandId}`);
    const { data: shopifyIntegration, error: integrationError } = await supabase
      .from('integrations')
      .select('shopify_shop_domain, access_token')
      .eq('brand_id', brandId)
      .eq('platform', 'shopify')
      .maybeSingle();

    if (integrationError || !shopifyIntegration) {
      console.error('❌ No Shopify integration found:', integrationError);
      return aiReply.replace('ORDER_READY',
        '✅ Your order details have been recorded! Our team will contact you shortly to complete the order.');
    }

    // Create Shopify order
    const shopifyOrder = await createShopifyOrder({
      shopDomain: shopifyIntegration.shopify_shop_domain,
      accessToken: shopifyIntegration.access_token,
      order: {
        variant_id: metadata.current_order.variant_id,
        product_name: metadata.current_order.product_name,
        price: metadata.current_order.price,
        customer_name: metadata.collected_info.name,
        customer_phone: metadata.collected_info.phone,
        customer_address: metadata.collected_info.address
      }
    });

    // Save order to database
    console.log(`   💾 Saving order to database...`);
    const { error: orderError } = await supabase
      .from('orders')
      .insert({
        brand_id: brandId,
        shopify_order_id: shopifyOrder.id.toString(),
        product_name: metadata.current_order.product_name,
        product_id: metadata.current_order.product_id,
        variant_id: metadata.current_order.variant_id,
        price: metadata.current_order.price,
        currency: 'EGP',
        customer_name: metadata.collected_info.name,
        customer_phone: metadata.collected_info.phone,
        customer_address: metadata.collected_info.address,
        status: 'pending',
        order_number: shopifyOrder.order_number || shopifyOrder.id
      });

    if (orderError) {
      console.error('❌ Error saving order to database:', orderError);
    } else {
      console.log(`✅ Order saved to database`);
    }

    // Build confirmation message
    const confirmationMessage = `
✅ Your order has been placed! Order #${shopifyOrder.order_number || shopifyOrder.id}

${metadata.current_order.product_name} — ${metadata.current_order.price} EGP
Delivering to: ${metadata.collected_info.address}

We'll contact you on ${metadata.collected_info.phone} to confirm. Thank you! 🎉
    `.trim();

    return aiReply.replace('ORDER_READY', confirmationMessage);
  } catch (error) {
    console.error('❌ Error creating order:', error);
    return aiReply.replace('ORDER_READY',
      '⚠️ There was an issue creating your order. Our team has been notified and will contact you shortly.');
  }
}

module.exports = router;
