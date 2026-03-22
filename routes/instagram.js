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
    if (body.object === 'instagram' || body.object === 'page') {
      for (const entry of body.entry) {
        for (const messagingEvent of entry.messaging || []) {
          const senderId = messagingEvent.sender?.id;
          const recipientId = messagingEvent.recipient?.id;

          if (senderId === recipientId) continue;

          if (messagingEvent.message && !messagingEvent.message.is_echo) {
            console.log(`📨 ${senderId}: "${messagingEvent.message.text}"`);
            await handleIncomingMessage(messagingEvent, recipientId);
          }
        }
      }
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
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
    const { data: integration } = await supabase
      .from('integrations')
      .select('brand_id, access_token')
      .eq('instagram_page_id', recipientId)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (!integration?.brand_id) {
      console.error(`❌ Error: No integration found for page ${recipientId}`);
      return;
    }

    const { brand_id, access_token } = integration;
    console.log(`🔍 Brand found: ${brand_id}`);

    // 2. Fetch knowledge base and products
    const { data: knowledgeBaseRows } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brand_id);

    const { data: products } = await supabase
      .from('products')
      .select('name, description, price, in_stock')
      .eq('brand_id', brand_id);

    // 3. Get or create conversation
    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('brand_id', brand_id)
      .eq('customer_id', senderId)
      .eq('platform', 'instagram')
      .maybeSingle();

    const defaultMetadata = {
      discussed_products: [],
      current_order: null,
      collected_info: { name: null, phone: null, address: null },
      awaiting: null
    };

    if (!conversation) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert({
          brand_id,
          customer_id: senderId,
          platform: 'instagram',
          status: 'active',
          metadata: defaultMetadata
        })
        .select()
        .single();

      conversation = newConv;
    }

    // Load metadata from database (CRITICAL - this is Luna's memory)
    let metadata = defaultMetadata;
    if (conversation?.metadata && typeof conversation.metadata === 'object') {
      metadata = { ...defaultMetadata, ...conversation.metadata };
    }
    console.log(`💾 Metadata: ${JSON.stringify(metadata)}`);

    // 4. CONFIRMATION CHECK (MUST BE FIRST - BEFORE STATE MACHINE)
    // If awaiting confirmation, check if customer confirmed and place order directly
    if (metadata.awaiting === 'confirmation') {
      const confirmWords = ['yes', 'confirm', 'ok', 'sure', 'place', 'yep', 'yeah', 'تأكيد', 'نعم', 'اه', 'آه', 'موافق'];
      const isConfirmed = confirmWords.some(word => messageText.toLowerCase().includes(word));

      if (isConfirmed) {
        // Customer confirmed - create Shopify order directly (skip OpenAI)
        console.log(`🎉 Order confirmed! Creating Shopify order...`);

        try {
          // Fetch Shopify integration
          const { data: shopifyIntegration } = await supabase
            .from('integrations')
            .select('shopify_shop_domain, access_token')
            .eq('brand_id', brand_id)
            .eq('platform', 'shopify')
            .single();

          let confirmationMsg;
          let shopifyOrderNumber = null;

          if (!shopifyIntegration) {
            // No Shopify integration found - log warning and skip Shopify API call
            console.log(`⚠️  No Shopify integration found for brand ${brand_id} - skipping Shopify order creation`);
            confirmationMsg = `✅ Your order has been recorded!\n\n• Product: ${metadata.current_order?.product_name || 'N/A'}\n• Price: ${metadata.current_order?.price || 'N/A'} EGP\n• Name: ${metadata.collected_info.name}\n• Phone: ${metadata.collected_info.phone}\n• Address: ${metadata.collected_info.address}\n\nOur team will contact you soon to confirm. Thank you! 🎉`;
          } else {
            // Shopify integration found - create order via Shopify Admin API
            const shopifyResponse = await fetch(
              `https://${shopifyIntegration.shopify_shop_domain}/admin/api/2024-01/orders.json`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Shopify-Access-Token': shopifyIntegration.access_token
                },
                body: JSON.stringify({
                  order: {
                    line_items: [{
                      title: metadata.current_order.product_name,
                      quantity: 1,
                      price: metadata.current_order.price
                    }],
                    customer: {
                      first_name: metadata.collected_info.name
                    },
                    shipping_address: {
                      name: metadata.collected_info.name,
                      address1: metadata.collected_info.address,
                      phone: metadata.collected_info.phone,
                      country: 'EG'
                    },
                    phone: metadata.collected_info.phone,
                    financial_status: 'pending',
                    send_receipt: false,
                    note: 'Order placed via Luna AI agent on Instagram/Messenger'
                  }
                })
              }
            );

            const shopifyData = await shopifyResponse.json();
            const shopifyOrder = shopifyData.order;
            const shopifyOrderId = shopifyOrder?.id;
            shopifyOrderNumber = shopifyOrder?.order_number;

            if (!shopifyResponse.ok) {
              console.error(`❌ Shopify API error: ${shopifyResponse.status}`, shopifyData);
              throw new Error(`Shopify API error: ${shopifyResponse.status}`);
            }

            console.log(`✅ Shopify order created: #${shopifyOrderNumber} for ${metadata.current_order.product_name}`);

            // Save to Supabase orders table
            await supabase.from('orders').insert({
              brand_id: brand_id,
              conversation_id: conversation.id,
              shopify_order_id: String(shopifyOrderId),
              shopify_order_number: String(shopifyOrderNumber),
              customer_name: metadata.collected_info.name,
              customer_phone: metadata.collected_info.phone,
              customer_address: metadata.collected_info.address,
              product_name: metadata.current_order.product_name,
              price: metadata.current_order.price,
              currency: 'EGP',
              status: 'pending',
              created_at: new Date().toISOString()
            });

            // Build confirmation message with order number
            confirmationMsg = `✅ Your order has been placed!\n\n• Order #${shopifyOrderNumber}\n• Product: ${metadata.current_order.product_name}\n• Price: ${metadata.current_order.price} EGP\n• Name: ${metadata.collected_info.name}\n• Phone: ${metadata.collected_info.phone}\n• Address: ${metadata.collected_info.address}\n\nWe'll contact you soon to confirm delivery. Thank you! 🎉`;
          }

          // Save incoming message
          await supabase
            .from('messages')
            .insert({
              conversation_id: conversation.id,
              sender: 'customer',
              content: messageText,
              platform_message_id: messageId,
            });

          // Send confirmation message directly
          await sendDM(senderId, confirmationMsg, access_token);
          console.log(`✅ Sent to ${senderId}`);

          // Save confirmation message
          await supabase
            .from('messages')
            .insert({
              conversation_id: conversation.id,
              sender: 'ai',
              content: confirmationMsg,
            });

          // Reset metadata after successful order
          metadata = {
            discussed_products: [],
            current_order: null,
            collected_info: { name: null, phone: null, address: null },
            awaiting: null
          };

          // Save reset metadata
          await supabase
            .from('conversations')
            .update({ metadata })
            .eq('id', conversation.id);

          // Return early - skip OpenAI call entirely
          return;

        } catch (error) {
          console.error(`❌ Error: ${error.message}`);
          // Fall through to normal flow if order creation fails
        }
      }
    }

    // 5. DETERMINISTIC STATE MACHINE: Process customer input based on current awaiting state
    // GUARD: Don't process through state machine if awaiting confirmation
    // Let Luna handle rejections/corrections via OpenAI
    if (metadata.awaiting !== 'confirmation') {
      if (metadata.awaiting === 'name') {
        metadata.collected_info.name = messageText.trim();
        metadata.awaiting = 'phone';
      } else if (metadata.awaiting === 'phone') {
        // Validation: Phone must contain at least 5 digits
        const phoneRegex = /\d{5,}/;
        if (phoneRegex.test(messageText)) {
          metadata.collected_info.phone = messageText.trim();
          metadata.awaiting = 'address';
        }
        // If invalid, don't save, don't advance state - Luna will ask again
      } else if (metadata.awaiting === 'address') {
        // Validation: Address must be at least 10 characters
        if (messageText.trim().length >= 10) {
          metadata.collected_info.address = messageText.trim();
          metadata.awaiting = 'confirmation';
        }
        // If invalid, don't save, don't advance state - Luna will ask again
      }
    }

    // 6. Fetch conversation history (last 10 messages)
    const { data: previousMessages } = await supabase
      .from('messages')
      .select('sender, content')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(10);

    // 7. Save incoming message
    await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'customer',
        content: messageText,
        platform_message_id: messageId,
      });

    // 8. Map conversation history to OpenAI format
    const conversationHistory = (previousMessages || []).map(msg => ({
      role: msg.sender === 'customer' ? 'user' : 'assistant',
      content: msg.content
    }));

    // 9. Fetch business name for system prompt
    const { data: user } = await supabase
      .from('users')
      .select('business_name')
      .eq('id', brand_id)
      .maybeSingle();
    const businessName = user?.business_name || 'our business';

    // 10. Generate AI reply with current metadata state
    const aiReply = await generateReply(
      messageText,
      knowledgeBaseRows || [],
      products || [],
      brand_id,
      conversationHistory,
      metadata,
      businessName
    );
    console.log(`🤖 Luna reply: "${aiReply}"`);

    // 11. Update metadata based on AI reply (only if awaiting is null)
    metadata = await updateMetadataFromConversation(
      messageText,
      aiReply,
      metadata,
      products || []
    );

    // 12. Send reply via Meta API
    await sendDM(senderId, aiReply, access_token);
    console.log(`✅ Sent to ${senderId}`);

    // 13. Save AI reply to database
    await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'ai',
        content: aiReply,
      });

    // 14. Metadata sanity check before saving
    // Prevent saving invalid phone/address data
    if (metadata.collected_info.phone) {
      const phoneRegex = /\d{5,}/;
      if (!phoneRegex.test(metadata.collected_info.phone)) {
        metadata.collected_info.phone = null; // Invalid phone, clear it
        if (metadata.awaiting === 'address' || metadata.awaiting === 'confirmation') {
          metadata.awaiting = 'phone'; // Go back to phone collection
        }
      }
    }
    if (metadata.collected_info.address) {
      if (metadata.collected_info.address.trim().length < 10) {
        metadata.collected_info.address = null; // Invalid address, clear it
        if (metadata.awaiting === 'confirmation') {
          metadata.awaiting = 'address'; // Go back to address collection
        }
      }
    }

    // 15. Save updated metadata (CRITICAL - this preserves order state across messages)
    await supabase
      .from('conversations')
      .update({ metadata })
      .eq('id', conversation.id);

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);

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
      console.error(`❌ Error: ${fallbackError.message}`);
    }
  }
}

/**
 * Update metadata based on conversation flow
 * Tracks discussed products, order state, and ONLY updates awaiting when it's null
 */
async function updateMetadataFromConversation(customerMessage, aiReply, metadata, products) {
  try {
    // Extract product mentions from conversation
    const productMentions = extractProductMentions(aiReply, products);

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

    // Detect if ordering a product (if not already ordering)
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

    // ONLY update awaiting if it's currently null (deterministic state machine handles transitions otherwise)
    if (metadata.awaiting === null) {
      const lowerReply = aiReply.toLowerCase();

      // Detect what Luna is asking for
      if (lowerReply.includes('full name') || lowerReply.includes('your name') || lowerReply.includes('اسمك')) {
        metadata.awaiting = 'name';
      } else if (lowerReply.includes('phone') || lowerReply.includes('رقم')) {
        metadata.awaiting = 'phone';
      }
    }

    return metadata;
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return metadata; // Return unchanged on error
  }
}

/**
 * Extract product mentions from AI reply
 */
function extractProductMentions(aiReply, products) {
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
