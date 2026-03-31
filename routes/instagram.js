const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { generateReply, checkEscalation } = require('../lib/claude');
const { sendDM } = require('../lib/meta');
const OpenAI = require('openai');

// Initialize OpenAI client for image similarity search
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

/**
 * Find products similar to a customer's image using vector similarity search
 * @param {string} imageUrl - URL of the customer's image
 * @param {string} brandId - Brand ID to search within
 * @returns {Promise<{matches: Array, queryDescription: string|null}>}
 */
async function findSimilarProducts(imageUrl, brandId) {
  try {
    // Download and encode customer's image as base64
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Generate description of customer's image using GPT-4o vision
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this clothing/product image in 2-3 sentences focusing on: type of item, colors, style, distinctive visual features.'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`,
              detail: 'low'
            }
          }
        ]
      }]
    });

    const queryDescription = visionResponse.choices[0].message.content;
    console.log(`🔍 Customer image described as: ${queryDescription}`);

    // Generate embedding for customer's image description
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: queryDescription
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Search for similar products using pgvector
    const { data: matches, error } = await supabase.rpc('match_products_by_embedding', {
      query_embedding: queryEmbedding,
      match_brand_id: brandId,
      match_threshold: 0.4,
      match_count: 3
    });

    if (error) {
      console.error('❌ Vector search error:', error.message);
      return { matches: [], queryDescription };
    }

    console.log(`🎯 Found ${matches?.length || 0} similar products`);
    return { matches: matches || [], queryDescription };

  } catch (err) {
    console.error('❌ Image similarity search failed:', err.message);
    return { matches: [], queryDescription: null };
  }
}

/**
 * Transcribe audio/voice note using OpenAI Whisper
 * @param {string} audioUrl - URL of the audio file from Instagram
 * @returns {Promise<string|null>} Transcribed text or null if failed
 */
async function transcribeAudio(audioUrl) {
  try {
    // Download audio file
    const response = await fetch(audioUrl);
    if (!response.ok) throw new Error(`Failed to download audio: ${response.status}`);

    const buffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(buffer);

    // Create a File object for OpenAI
    const { toFile } = await import('openai');
    const audioFile = await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' });

    // Transcribe with Whisper (supports Arabic, English, Franco Arabic)
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'ar' // Primary language hint (auto-detects others)
    });

    console.log(`🎤 Transcribed: "${transcription.text}"`);
    return transcription.text;
  } catch (err) {
    console.error('❌ Transcription failed:', err.message);
    return null;
  }
}

/**
 * Fetch customer's Instagram/Facebook profile (name and username)
 */
async function getCustomerProfile(senderId, accessToken) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${senderId}?fields=name,username&access_token=${accessToken}`
    );
    const data = await response.json();
    return {
      name: data.name || null,
      username: data.username || null
    };
  } catch (err) {
    console.error('Failed to fetch customer profile:', err.message);
    return { name: null, username: null };
  }
}

/**
 * Format Egyptian phone numbers to E.164 format for Shopify
 * Converts: 01234567890 → +201234567890
 */
function formatEgyptianPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) {
    return '+2' + digits;
  }
  if (digits.startsWith('20') && digits.length === 12) {
    return '+' + digits;
  }
  if (digits.startsWith('2') && digits.length === 11) {
    return '+' + digits;
  }
  return '+2' + digits;
}

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
        // At the very top of message processing, before any logs
        const messaging = entry.messaging?.[0];
        if (!messaging) continue;

        // Filter out echo messages (Luna's own replies)
        if (messaging.message?.is_echo) continue;

        // Filter out read receipts
        if (messaging.read) continue;

        // Filter out delivery receipts
        if (messaging.delivery) continue;

        // Check sender/recipient validity
        const senderId = messaging.sender?.id;
        const recipientId = messaging.recipient?.id;

        if (!senderId || !recipientId || senderId === recipientId) continue;

        // Now extract message content
        const customerMessage = messaging.message?.text;
        const attachments = messaging.message?.attachments || [];
        const imageAttachment = attachments.find(a => a.type === 'image');
        const imageUrl = imageAttachment?.payload?.url || null;
        const audioAttachment = attachments.find(a => a.type === 'audio');
        const audioUrl = audioAttachment?.payload?.url || null;

        // Detect shared Instagram posts (template type)
        const templateAttachment = attachments.find(a => a.type === 'template');
        const sharedPostImageUrl = templateAttachment?.payload?.elements?.[0]?.image_url
          || templateAttachment?.payload?.elements?.[0]?.url
          || null;

        // Use shared post image if no direct image was sent
        const effectiveImageUrl = imageUrl || sharedPostImageUrl;

        // Detect story replies
        const storyReply = messaging.message?.reply_to?.story || null;
        const storyImageUrl = storyReply?.url || null;
        const storyId = storyReply?.id || null;

        if (storyReply) {
          console.log(`📖 Customer replied to a story: ${storyId}`);
        }

        // Only proceed if there's actual content
        if (!customerMessage && !effectiveImageUrl && !audioUrl && !storyReply) continue;

        // NOW log - only real messages reach this point
        if (sharedPostImageUrl) console.log('📤 Customer shared a post, extracting image...');
        const logMessage = customerMessage || (effectiveImageUrl ? '[Image]' : (storyReply ? '[Story Reply]' : '[Voice Note]'));
        console.log(`📨 ${senderId}: "${logMessage}"`);

        // Process the message
        await handleIncomingMessage(messaging, recipientId);
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
 * NOTE: This function only receives validated messages with actual content
 */
async function handleIncomingMessage(messagingEvent, recipientId) {
  const senderId = messagingEvent.sender.id;
  let customerMessage = messagingEvent.message?.text;
  const messageId = messagingEvent.message.mid;

  // Detect attachments (image, audio, and shared posts)
  const attachments = messagingEvent.message?.attachments || [];
  const imageAttachment = attachments.find(a => a.type === 'image');
  const imageUrl = imageAttachment?.payload?.url || null;
  const audioAttachment = attachments.find(a => a.type === 'audio');
  const audioUrl = audioAttachment?.payload?.url || null;

  // Detect shared Instagram posts (template type)
  const templateAttachment = attachments.find(a => a.type === 'template');
  const sharedPostImageUrl = templateAttachment?.payload?.elements?.[0]?.image_url
    || templateAttachment?.payload?.elements?.[0]?.url
    || null;

  // Use shared post image if no direct image was sent
  const effectiveImageUrl = imageUrl || sharedPostImageUrl;

  if (sharedPostImageUrl) {
    console.log('📤 Customer shared a post, extracting image for vector search...');
  }

  // Detect story replies
  const storyReply = messagingEvent.message?.reply_to?.story || null;
  const storyImageUrl = storyReply?.url || null;
  const storyId = storyReply?.id || null;

  if (storyReply) {
    console.log(`📖 Customer replied to story: ${storyId}`);
  }

  // Guard: ignore events with no content
  if (!customerMessage && !effectiveImageUrl && !audioUrl && !storyReply) {
    console.log(`ℹ️  Ignoring event with no content from ${senderId}`);
    return;
  }

  // Handle voice notes - transcribe to text
  let finalMessage = customerMessage;

  // If story reply with no text, set a default message
  if (!finalMessage && storyReply) {
    finalMessage = 'The customer replied to your story without adding text.';
  }

  if (audioUrl) {
    console.log('🎤 Voice note received, transcribing...');
    const transcribed = await transcribeAudio(audioUrl);
    if (transcribed) {
      finalMessage = transcribed;
      console.log(`✅ Using transcription: "${transcribed}"`);
    } else {
      // Fallback if transcription fails
      finalMessage = 'The customer sent a voice note that could not be transcribed.';
      console.log('⚠️  Transcription failed, using fallback message');
    }
  }

  // Handle story replies - describe the story for context
  let storyContext = '';
  if (storyImageUrl) {
    try {
      console.log('📖 Processing story image for context...');
      // Download and describe the story
      const response = await fetch(storyImageUrl);
      if (!response.ok) throw new Error(`Failed to download story: ${response.status}`);

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = response.headers.get('content-type') || 'image/jpeg';

      const visionResponse = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this Instagram story briefly - what product or content is shown?' },
            { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}`, detail: 'low' } }
          ]
        }]
      });

      storyContext = visionResponse.choices[0].message.content;
      console.log(`📖 Story content: ${storyContext}`);
    } catch (err) {
      console.error('❌ Story image processing failed:', err.message);
      storyContext = 'Customer replied to one of your stories';
    }
  } else if (storyReply) {
    // Story reply but no image URL available
    storyContext = 'Customer replied to one of your stories';
  }

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

    // 1b. Check if conversation is escalated (human has taken over)
    const { data: existingConv } = await supabase
      .from('conversations')
      .select('is_escalated, is_luna_active, status')
      .eq('instagram_thread_id', senderId)
      .eq('brand_id', brand_id)
      .maybeSingle();

    if (existingConv && (existingConv.is_escalated === true || existingConv.is_luna_active === false)) {
      console.log(`⏸️ Luna is paused for ${senderId}`);
      return;
    }

    // 1c. Fetch customer profile
    const profile = await getCustomerProfile(senderId, access_token);
    console.log(`👤 Customer: ${profile.name} (@${profile.username})`);

    // 2. Fetch knowledge base and products
    const { data: knowledgeBaseRows } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brand_id);

    // Fetch ALL products - both in stock and out of stock
    const { data: products } = await supabase
      .from('products')
      .select('name, price, variants, image_url, shopify_product_id, in_stock')
      .eq('brand_id', brand_id)
      .not('price', 'is', null)
      .gt('price', 0)
      .order('name', { ascending: true });

    // Separate into available and unavailable
    const inStockProducts = products?.filter(p => p.in_stock) || [];
    const outOfStockProducts = products?.filter(p => !p.in_stock) || [];

    // 3. Upsert conversation with customer profile info
    const defaultMetadata = {
      discussed_products: [],
      current_order: null,
      collected_info: { name: null, phone: null, address: null },
      awaiting: null
    };

  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .upsert({
      brand_id,
      instagram_thread_id: senderId,
      customer_id: senderId,          // ← was customer_instagram_id, correct is customer_id
      customer_name: profile.name,
      customer_username: profile.username,
      status: 'active',
      is_escalated: false,
      is_luna_active: true,
      last_message: finalMessage || '[Image]',
      last_message_at: new Date().toISOString(),
      channel: 'instagram'
    }, { onConflict: 'instagram_thread_id' })
    .select()
    .maybeSingle();

    if (convError) {
      console.error('❌ Failed to upsert conversation:', convError.message);
      return;
    }

    if (!conversation) {
      console.error('❌ Conversation upsert returned null');
      return;
    }

    // Load metadata from database (CRITICAL - this is Luna's memory)
    let metadata = defaultMetadata;
    if (conversation?.metadata && typeof conversation.metadata === 'object') {
      metadata = { ...defaultMetadata, ...conversation.metadata };
    }
    console.log(`💾 Metadata: ${JSON.stringify(metadata)}`);

    // 4. ESCALATION CHECK - use existingConv (pre-upsert state) to detect escalation
    // The upsert sets is_escalated: false, so conversation.is_escalated is always false here
    if (existingConv?.is_escalated === true) {
      console.log(`🚨 Conversation is escalated - AI will not respond`);

      // Still save the incoming message for the team to see
      await supabase
        .from('messages')
        .insert({
          conversation_id: conversation.id,
          direction: 'inbound',
          content: finalMessage || '[Image]',
          sender_name: profile.name || 'Customer',
          is_luna: false,
          sent_at: new Date().toISOString()
        });

      // Don't send any reply - let human team handle it
      return;
    }

    // 5. CONFIRMATION CHECK (MUST BE FIRST - BEFORE STATE MACHINE)
    // If awaiting confirmation, check if customer confirmed and place order directly
    if (metadata.awaiting === 'confirmation') {
      // Null safe confirmation check
      const msgText = finalMessage || '';
      const confirmWords = ['yes', 'confirm', 'ok', 'sure', 'place', 'yep', 'yeah', 'تأكيد', 'نعم', 'اه', 'آه', 'موافق'];
      const isConfirmed = confirmWords.some(word => msgText.toLowerCase().includes(word));

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
            // Format phone to E.164 format for Shopify
            const formattedPhone = formatEgyptianPhone(metadata.collected_info.phone);

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
                      phone: formattedPhone,
                      country: 'EG'
                    },
                    phone: formattedPhone,
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

              // Handle Shopify failure gracefully - don't fall back to OpenAI
              const errorMsg = "Sorry, we couldn't place your order right now. Please try again or contact us directly.";

              await sendDM(senderId, errorMsg, access_token);
              console.log(`✅ Sent error message to ${senderId}`);

              await supabase.from('messages').insert([
                {
                  conversation_id: conversation.id,
                  direction: 'inbound',
                  content: finalMessage || '[Image]',
                  sender_name: profile.name || 'Customer',
                  is_luna: false,
                  sent_at: new Date().toISOString()
                },
                {
                  conversation_id: conversation.id,
                  direction: 'outbound',
                  content: errorMsg,
                  sender_name: 'Luna',
                  is_luna: true,
                  sent_at: new Date().toISOString()
                }
              ]);

              // Keep metadata intact so customer can try again
              // Return early - skip OpenAI call
              return;
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

          // Send confirmation message directly
          await sendDM(senderId, confirmationMsg, access_token);
          console.log(`✅ Sent to ${senderId}`);

          // Save inbound + outbound messages
          await supabase.from('messages').insert([
            {
              conversation_id: conversation.id,
              direction: 'inbound',
              content: finalMessage || '[Image]',
              sender_name: profile.name || 'Customer',
              is_luna: false,
              sent_at: new Date().toISOString()
            },
            {
              conversation_id: conversation.id,
              direction: 'outbound',
              content: confirmationMsg,
              sender_name: 'Luna',
              is_luna: true,
              sent_at: new Date().toISOString()
            }
          ]);

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

    // 6. DETERMINISTIC STATE MACHINE: Process customer input based on current awaiting state
    // GUARD: Don't process through state machine if awaiting confirmation
    // Let Luna handle rejections/corrections via OpenAI
    // Null safe state machine - only process text messages for data collection
    if (metadata.awaiting !== 'confirmation' && finalMessage) {
      if (metadata.awaiting === 'name') {
        metadata.collected_info.name = finalMessage.trim();
        metadata.awaiting = 'phone';
      } else if (metadata.awaiting === 'phone') {
        // Validation: Phone must contain at least 5 digits
        const phoneRegex = /\d{5,}/;
        if (phoneRegex.test(finalMessage)) {
          metadata.collected_info.phone = finalMessage.trim();
          metadata.awaiting = 'address';
        }
        // If invalid, don't save, don't advance state - Luna will ask again
      } else if (metadata.awaiting === 'address') {
        // Validation: Address must be at least 10 characters
        if (finalMessage.trim().length >= 10) {
          metadata.collected_info.address = finalMessage.trim();
          metadata.awaiting = 'confirmation';
        }
        // If invalid, don't save, don't advance state - Luna will ask again
      }
    }

    // 7. Fetch conversation history (last 10 messages)
    const { data: previousMessages } = await supabase
      .from('messages')
      .select('sender, content')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(10);

    // 8. Save incoming message (deferred - will batch with outbound after reply is generated)

    // 9. Map conversation history to OpenAI format
    const conversationHistory = (previousMessages || []).map(msg => ({
      role: msg.sender === 'customer' ? 'user' : 'assistant',
      content: msg.content
    }));

    // 10. Fetch business name for system prompt
    const { data: user } = await supabase
      .from('users')
      .select('business_name')
      .eq('id', brand_id)
      .maybeSingle();
    const businessName = user?.business_name || 'our business';

    // 11. Generate AI reply
    let aiReply;

    if (effectiveImageUrl) {
      // IMAGE FLOW: Use vector similarity search to find matching products
      console.log('📸 Processing customer image with vector search...');
      const { matches, queryDescription } = await findSimilarProducts(effectiveImageUrl, brand_id);

      if (matches && matches.length > 0) {
        // Found similar products - build focused prompt with matches
        const matchList = matches.map(p =>
          `- ${p.name}: ${p.price} EGP, ${p.in_stock ? 'In Stock ✅' : 'Out of Stock ❌'}\n  Visual match: ${p.image_description || 'N/A'}\n  Similarity: ${(p.similarity * 100).toFixed(0)}%`
        ).join('\n\n');

        // Build system prompt with knowledge base and matched products
        const { buildSystemPrompt } = require('../lib/claude');
        const baseSystemPrompt = buildSystemPrompt(businessName, knowledgeBaseRows || [], inStockProducts, outOfStockProducts, metadata);

        // Add story context if available
        const storySection = storyContext
          ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📖 STORY CONTEXT\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nThe customer is replying to your story that shows: ${storyContext}\nUse this context to understand what they're asking about.\n`
          : '';

        const imageSystemPrompt = `${baseSystemPrompt}${storySection}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 IMAGE SEARCH RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The customer sent an image. Based on visual similarity search, these are the most likely matching products:

${matchList}

Customer's image looks like: ${queryDescription}

IMPORTANT:
- Confirm which product matches best based on the similarity scores and descriptions
- State availability and price clearly - VERY IMPORTANT!
- If product is OUT OF STOCK ❌: Tell customer "This looks like our [Product Name] (PRICE EGP), but unfortunately it's currently out of stock. Would you like me to suggest similar items that are available?"
- If product is IN STOCK ✅: Confirm it's available and ask if they want to order
- If the match quality seems low (similarity < 50%), acknowledge it might not be an exact match
- If ALL matches are out of stock, acknowledge the product but suggest checking back later or looking at alternatives
`;

        // Use GPT-4o-mini for the final response (we already did the heavy lifting with vision)
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: imageSystemPrompt },
            ...conversationHistory,
            { role: 'user', content: finalMessage || 'Do you have this product?' }
          ],
          max_tokens: 400
        });

        aiReply = completion.choices[0].message.content;
        console.log(`🤖 Luna reply (image match): "${aiReply}"`);

      } else {
        // No matches found - fallback to friendly message
        aiReply = "Sorry, I couldn't find an exact match for this item in our current collection. Could you describe what you're looking for? For example, the color, style, or type of product? That way I can help you find something similar! 😊";
        console.log(`🤖 Luna reply (no match): "${aiReply}"`);
      }

    } else {
      // TEXT FLOW: Normal conversation without image
      aiReply = await generateReply(
        finalMessage,
        knowledgeBaseRows || [],
        inStockProducts,
        outOfStockProducts,
        brand_id,
        conversationHistory,
        metadata,
        businessName,
        null,  // No image URL
        storyContext  // Story context if replying to story
      );
      console.log(`🤖 Luna reply: "${aiReply}"`);
    }

    // 12. Check for escalation keywords in AI reply
    const escalationCheck = checkEscalation(aiReply);

    if (escalationCheck.shouldEscalate) {
      console.log(`🚨 Escalation detected: ${escalationCheck.type}`);
      console.log(`   Reason: ${escalationCheck.reason}`);

      // Update conversation to mark as escalated
      await supabase
        .from('conversations')
        .update({
          is_escalated: true,
          escalation_type: escalationCheck.type,
          escalation_reason: escalationCheck.reason,
          escalated_at: new Date().toISOString(),
          escalated_by: 'ai'
        })
        .eq('id', conversation.id);

      // Auto-create refund/exchange record based on type
      if (escalationCheck.type === 'refund') {
        const refundData = {
          brand_id,
          conversation_id: conversation.id,
          customer_id: senderId,
          customer_name: metadata.collected_info?.name || null,
          customer_phone: metadata.collected_info?.phone || null,
          original_order_number: metadata.current_order?.product_name ? 'From conversation' : null,
          product_name: metadata.current_order?.product_name || 'Product name not captured',
          order_amount: metadata.current_order?.price || null,
          refund_amount: metadata.current_order?.price || null,
          refund_reason: 'defective', // Default, can be updated by team
          refund_reason_details: `Customer message: ${finalMessage}`,
          status: 'pending'
        };

        await supabase.from('refunds').insert(refundData);
        console.log('✅ Auto-created refund record');
      }

      if (escalationCheck.type === 'exchange') {
        const exchangeData = {
          brand_id,
          conversation_id: conversation.id,
          customer_id: senderId,
          customer_name: metadata.collected_info?.name || null,
          customer_phone: metadata.collected_info?.phone || null,
          customer_address: metadata.collected_info?.address || null,
          original_product_name: metadata.current_order?.product_name || 'Product name not captured',
          original_size: null, // To be filled by team
          exchange_reason: 'size_issue', // Default, can be updated by team
          exchange_reason_details: `Customer message: ${finalMessage}`,
          status: 'pending'
        };

        await supabase.from('exchanges').insert(exchangeData);
        console.log('✅ Auto-created exchange record');
      }

      // Remove escalation keywords from reply before sending to customer
      aiReply = aiReply
        .replace(/ESCALATE_EXCHANGE/gi, '')
        .replace(/ESCALATE_REFUND/gi, '')
        .replace(/ESCALATE_DELIVERY/gi, '')
        .replace(/ESCALATE_GENERAL/gi, '')
        .trim();

      console.log(`🤖 Cleaned reply (escalation keywords removed): "${aiReply}"`);
    }

    // 13. Update metadata based on AI reply (only if awaiting is null)
    metadata = await updateMetadataFromConversation(
      finalMessage,
      aiReply,
      metadata,
      inStockProducts
    );

    // 14. Send reply via Meta API
    await sendDM(senderId, aiReply, access_token);
    console.log(`✅ Sent to ${senderId}`);

    // 15. Save inbound + outbound messages and update last_message
    await supabase.from('messages').insert([
      {
        conversation_id: conversation.id,
        direction: 'inbound',
        content: finalMessage || '[Image]',
        sender_name: profile.name || 'Customer',
        is_luna: false,
        sent_at: new Date().toISOString()
      },
      {
        conversation_id: conversation.id,
        direction: 'outbound',
        content: aiReply,
        sender_name: 'Luna',
        is_luna: true,
        sent_at: new Date().toISOString()
      }
    ]);

    await supabase
      .from('conversations')
      .update({
        last_message: aiReply,
        last_message_at: new Date().toISOString()
      })
      .eq('id', conversation.id);

    // 15b. Escalation detection based on customer message or Luna's reply
    const escalationTriggers = [
      'speak to human', 'real person', 'manager', 'supervisor',
      'not helpful', 'useless', 'complaint', 'legal', 'lawsuit',
      'كلم حد', 'مدير', 'شكوى', 'مش بتساعد'
    ];

    const shouldEscalate = escalationTriggers.some(trigger =>
      finalMessage?.toLowerCase().includes(trigger)
    ) || aiReply.includes('ESCALATE');

    if (shouldEscalate) {
      await supabase
        .from('conversations')
        .update({
          status: 'escalated',
          is_escalated: true
        })
        .eq('id', conversation.id);
      console.log(`🚨 Conversation escalated: ${conversation.id}`);
    }

    // 16. Metadata sanity check before saving
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

    // 17. Save updated metadata (CRITICAL - this preserves order state across messages)
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
