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
    // Check if this is a message event (can be 'instagram' or 'page')
    if (body.object === 'instagram' || body.object === 'page') {
      for (const entry of body.entry) {
        for (const messagingEvent of entry.messaging || []) {
          const senderId = messagingEvent.sender?.id;
          const recipientId = messagingEvent.recipient?.id;

          // Ignore messages sent by the page itself (avoid reply loops)
          if (senderId === recipientId) continue;

          // Only process incoming messages (not echoes or read receipts)
          if (messagingEvent.message && !messagingEvent.message.is_echo) {
            console.log(`\n📨 Message from ${senderId}: "${messagingEvent.message.text}"`);
            await handleIncomingMessage(messagingEvent, recipientId);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
  } finally {
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

  try {
    // 1. Look up the brand using recipient.id
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('brand_id, access_token')
      .eq('instagram_page_id', recipientId)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (integrationError || !integration?.brand_id) {
      console.error('❌ No integration found for page:', recipientId);
      return;
    }

    const { brand_id, access_token } = integration;

    // 2. Fetch knowledge base for the brand
    const { data: knowledgeBaseRows } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brand_id);

    // 3. Fetch products for the brand
    const { data: products } = await supabase
      .from('products')
      .select('name, description, price, in_stock')
      .eq('brand_id', brand_id);

    // 4. Get or create conversation
    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('brand_id', brand_id)
      .eq('customer_id', senderId)
      .eq('platform', 'instagram')
      .maybeSingle();

    // Initialize default metadata
    const defaultMetadata = {
      discussed_products: [],
      current_order: null,
      collected_info: { name: null, phone: null, address: null },
      awaiting: null
    };

    if (!conversation) {
      // Create new conversation with metadata (if column exists, otherwise ignore)
      const insertData = {
        brand_id,
        customer_id: senderId,
        platform: 'instagram',
        status: 'active'
      };

      // Try to include metadata, if it fails the column doesn't exist yet
      try {
        insertData.metadata = defaultMetadata;
      } catch (e) {
        // Column doesn't exist, skip it
      }

      const { data: newConv } = await supabase
        .from('conversations')
        .insert(insertData)
        .select()
        .single();

      conversation = newConv;
    }

    // Load conversation metadata (with fallback if column doesn't exist)
    let metadata = defaultMetadata;
    if (conversation && typeof conversation.metadata === 'object') {
      metadata = { ...defaultMetadata, ...conversation.metadata };
    }

    // 5. Fetch conversation history (last 10 messages)
    const { data: previousMessages } = await supabase
      .from('messages')
      .select('sender, content')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(10);

    // 6. Save incoming message
    await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'customer',
        content: messageText,
        platform_message_id: messageId,
      });

    // 7. Map conversation history to OpenAI message format
    const conversationHistory = (previousMessages || []).map(msg => ({
      role: msg.sender === 'customer' ? 'user' : 'assistant',
      content: msg.content
    }));

    // 8. Fetch business name for system prompt
    const { data: user } = await supabase
      .from('users')
      .select('business_name')
      .eq('id', brand_id)
      .maybeSingle();
    const businessName = user?.business_name || 'our business';

    // 9. Generate AI reply using OpenAI with conversation history and metadata
    console.log(`🤖 Generating reply...`);
    const aiReply = await generateReply(
      messageText,
      knowledgeBaseRows || [],
      products || [],
      brand_id,
      conversationHistory,
      metadata,
      businessName
    );

    // 10. Parse and update metadata based on AI reply and customer message
    metadata = await updateMetadataFromConversation(
      messageText,
      aiReply,
      metadata,
      products || [],
      previousMessages || []
    );

    // 11. Check if ORDER_READY was detected
    let finalReply = aiReply;
    if (aiReply.includes('ORDER_READY')) {
      console.log(`🎉 Creating order...`);
      finalReply = await handleOrderCreation(brand_id, metadata, aiReply);

      // Reset order state after successful order
      metadata.current_order = null;
      metadata.collected_info = { name: null, phone: null, address: null };
      metadata.awaiting = null;
    }

    // 12. Send reply via Meta API
    const sendResponse = await sendDM(senderId, finalReply, access_token);
    console.log(`✅ Reply sent`);

    // 13. Save AI reply to database
    await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'ai',
        content: finalReply,
        platform_message_id: sendResponse.message_id,
      });

    // 14. Save updated metadata to conversation (if column exists)
    try {
      await supabase
        .from('conversations')
        .update({ metadata })
        .eq('id', conversation.id);
    } catch (e) {
      // Metadata column doesn't exist yet, skip
    }
  } catch (error) {
    console.error('❌ Error:', error.message);

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
      console.error('❌ Fallback failed:', fallbackError.message);
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
      metadata.collected_info.name = customerMessage.trim();
    } else if (metadata.awaiting === 'phone') {
      metadata.collected_info.phone = customerMessage.trim();
    } else if (metadata.awaiting === 'address') {
      metadata.collected_info.address = customerMessage.trim();
    }

    // Detect what Luna is currently asking for
    metadata.awaiting = detectAwaitingState(aiReply, metadata);

    // Detect if ordering a product
    if (!metadata.current_order && detectOrderIntent(customerMessage, aiReply)) {
      const orderedProduct = identifyOrderedProduct(
        customerMessage,
        aiReply,
        metadata.discussed_products,
        products
      );
      if (orderedProduct) {
        metadata.current_order = orderedProduct;
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
      return aiReply.replace('ORDER_READY',
        '⚠️ There was an issue processing your order. Please try again or contact our team.');
    }

    if (!metadata.collected_info.name ||
        !metadata.collected_info.phone ||
        !metadata.collected_info.address) {
      return aiReply.replace('ORDER_READY',
        '⚠️ We need a bit more information to complete your order. Please provide your full details.');
    }

    // Fetch Shopify integration
    const { data: shopifyIntegration } = await supabase
      .from('integrations')
      .select('shopify_shop_domain, access_token')
      .eq('brand_id', brandId)
      .eq('platform', 'shopify')
      .maybeSingle();

    if (!shopifyIntegration) {
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
    await supabase
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
