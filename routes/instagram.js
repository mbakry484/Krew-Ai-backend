const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { generateReply, checkEscalation } = require('../lib/claude');
const { sendDM, sendImageDM, getUserProfile } = require('../lib/meta');
const OpenAI = require('openai');
const { toFile } = require('openai');
const langfuse = require('../lib/tracer');
const { getValidPageToken } = require('../src/utils/metaToken');
const { logUsage } = require('../lib/usage-logger');
const { trackInteraction } = require('../lib/interaction-tracker');

// Initialize OpenAI client for image similarity search
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

/**
 * Download an image from a URL and upload it to Supabase Storage.
 * Returns a permanent public URL, or the original URL if upload fails.
 */
async function uploadImageToStorage(imageUrl, brandId) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return imageUrl;
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
    const fileName = `conversation-images/${brandId}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from('knowledge-base')
      .upload(fileName, buffer, { contentType, upsert: false });
    if (error) return imageUrl;
    const { data } = supabase.storage.from('knowledge-base').getPublicUrl(fileName);
    return data.publicUrl || imageUrl;
  } catch {
    return imageUrl;
  }
}

// Pending image buffer: holds images waiting for a follow-up text message
// Key: senderId, Value: { messaging, recipientId, timer }
const pendingImages = new Map();
const IMAGE_WAIT_MS = 15000;

/**
 * Find products similar to a customer's image using vector similarity search
 * @param {string} imageUrl - URL of the customer's image
 * @param {string} brandId - Brand ID to search within
 * @returns {Promise<{matches: Array, queryDescription: string|null}>}
 */
async function findSimilarProducts(imageUrl, brandId, conversationId = null) {
  try {
    // Download and encode customer's image as base64
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Generate description of customer's image using GPT-4o vision
    // Use detail: 'auto' (not 'low') so GPT-4o can pick up subtle features
    // from customer photos which are often lower quality or different angles
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
              detail: 'auto'
            }
          }
        ]
      }]
    });

    const queryDescription = visionResponse.choices[0].message.content;
    console.log(`🔍 Customer image described as: ${queryDescription}`);

    logUsage({
      brandId,
      conversationId,
      messageType: 'image',
      model: 'gpt-4o',
      promptTokens: visionResponse.usage?.prompt_tokens ?? 0,
      completionTokens: visionResponse.usage?.completion_tokens ?? 0,
      totalTokens: visionResponse.usage?.total_tokens ?? 0
    });

    // Generate embedding from description only — matches the format used for
    // stored product embeddings (description-only, no product name prefix).
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: queryDescription
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Search for similar products using pgvector
    // Use a higher threshold (0.5) to avoid weak matches being presented as real results
    // Fetch more candidates (5) so we can filter client-side
    const { data: rawMatches, error } = await supabase.rpc('match_products_by_embedding', {
      query_embedding: queryEmbedding,
      match_brand_id: brandId,
      match_threshold: 0.35,
      match_count: 5
    });

    if (error) {
      console.error('❌ Vector search error:', error.message);
      return { matches: [], queryDescription };
    }

    // Sort strictly by similarity score (ignore the SQL's in_stock-first ordering)
    // Threshold 0.42 balances catching legitimate matches (different angles/lighting)
    // while still filtering out clearly wrong products
    const SIMILARITY_THRESHOLD = 0.42;
    const matches = (rawMatches || [])
      .sort((a, b) => b.similarity - a.similarity)
      .filter(m => m.similarity >= SIMILARITY_THRESHOLD)
      .slice(0, 3);

    const best = matches[0]?.similarity?.toFixed(2) || 'none';
    console.log(`🎯 Found ${matches.length} confident matches above ${SIMILARITY_THRESHOLD} (best: ${best})`);
    if (matches.length > 0) {
      matches.forEach(m => {
        console.log(`   • ${m.name} | similarity: ${(m.similarity * 100).toFixed(1)}% | in_stock: ${m.in_stock}`);
      });
    }
    return { matches, queryDescription };

  } catch (err) {
    console.error('❌ Image similarity search failed:', err.message);
    return { matches: [], queryDescription: null };
  }
}

/**
 * Transcribe audio/voice note using OpenAI Whisper
 * @param {string} audioUrl - URL of the audio file from Instagram
 * @param {string} [whisperPrompt] - Optional context prompt for Whisper
 * @returns {Promise<{text: string|null, durationSeconds: number}>}
 */
async function transcribeAudio(audioUrl, whisperPrompt = '') {
  try {
    // Download audio file and detect its content type
    const response = await fetch(audioUrl);
    if (!response.ok) throw new Error(`Failed to download audio: ${response.status}`);

    const contentType = response.headers.get('content-type') || 'audio/ogg';
    const buffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(buffer);

    // Map content-type to a file extension Whisper understands
    const extMap = {
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'mp4',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'video/mp4': 'mp4',
    };
    const ext = extMap[contentType] || 'ogg';
    const audioFile = await toFile(audioBuffer, `audio.${ext}`, { type: contentType });

    // Use verbose_json to get audio duration for usage logging
    // Omit language so Whisper auto-detects (handles English, Arabic, Franco Arabic correctly)
    const transcriptionRequest = {
      file: audioFile,
      model: 'whisper-1',
      response_format: 'verbose_json',
    };
    if (whisperPrompt) {
      transcriptionRequest.prompt = whisperPrompt;
    }

    const transcription = await openai.audio.transcriptions.create(transcriptionRequest);
    const text = transcription.text?.trim() || null;
    const durationSeconds = transcription.duration ?? 0;

    console.log(`🎤 Transcribed (${ext}): "${text}"`);
    return { text: text || null, durationSeconds };
  } catch (err) {
    console.error('❌ Transcription failed:', err.message);
    return { text: null, durationSeconds: 0 };
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

        // IMAGE WAIT LOGIC:
        // If this is a pure image (no text), buffer it and wait IMAGE_WAIT_MS for a follow-up text.
        // If a text message arrives while an image is pending, combine them and process together.
        const isImageOnly = effectiveImageUrl && !customerMessage && !audioUrl && !storyReply;
        const hasPendingImage = pendingImages.has(senderId);

        if (isImageOnly) {
          // Cancel any existing pending image for this sender (replace with latest)
          if (hasPendingImage) {
            clearTimeout(pendingImages.get(senderId).timer);
          }
          console.log(`⏳ Image received from ${senderId} — waiting ${IMAGE_WAIT_MS / 1000}s for follow-up text`);
          const timer = setTimeout(async () => {
            pendingImages.delete(senderId);
            console.log(`⏰ No follow-up received — processing image alone for ${senderId}`);
            await handleIncomingMessage(messaging, recipientId);
          }, IMAGE_WAIT_MS);
          pendingImages.set(senderId, { messaging, recipientId, timer });
          continue; // Don't process yet
        }

        if (customerMessage && hasPendingImage) {
          // Text arrived while an image was pending — combine them
          const pending = pendingImages.get(senderId);
          clearTimeout(pending.timer);
          pendingImages.delete(senderId);
          console.log(`✅ Follow-up text received — combining with pending image for ${senderId}`);
          // Merge the text into the pending image messaging event
          const combinedMessaging = {
            ...pending.messaging,
            message: {
              ...pending.messaging.message,
              text: customerMessage
            }
          };
          await handleIncomingMessage(combinedMessaging, pending.recipientId);
          continue;
        }

        // Normal message (text, audio, story — no pending image involved)
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
  // Shared posts are the brand's own content — treat them like story replies (context analysis),
  // NOT like a customer's product search image (vector search). Keep effectiveImageUrl for
  // direct image attachments only.
  const templateAttachment = attachments.find(a => a.type === 'template');
  const sharedPostImageUrl = templateAttachment?.payload?.elements?.[0]?.image_url
    || templateAttachment?.payload?.elements?.[0]?.url
    || null;
  const sharedPostTitle = templateAttachment?.payload?.elements?.[0]?.title || null;
  const sharedPostSubtitle = templateAttachment?.payload?.elements?.[0]?.subtitle || null;

  // effectiveImageUrl = only direct image attachments (for vector search)
  const effectiveImageUrl = imageUrl || null;

  if (sharedPostImageUrl) {
    console.log(`📤 Customer shared a brand post: "${sharedPostTitle || 'no title'}"`);
  }

  // Detect story replies
  const storyReply = messagingEvent.message?.reply_to?.story || null;
  const storyImageUrl = storyReply?.url || null;
  const storyId = storyReply?.id || null;

  if (storyReply) {
    console.log(`📖 Customer replied to story: ${storyId}`);
  }

  // Guard: ignore events with no content
  if (!customerMessage && !effectiveImageUrl && !audioUrl && !storyReply && !sharedPostImageUrl) {
    console.log(`ℹ️  Ignoring event with no content from ${senderId}`);
    return;
  }

  // Handle voice notes - transcription happens later after products are fetched
  // so we can prime Whisper with product name vocabulary for better accuracy
  let finalMessage = customerMessage;

  // If story reply with no text, set a default message
  if (!finalMessage && storyReply && !sharedPostImageUrl) {
    finalMessage = 'The customer replied to your story without adding text.';
  }

  // Download story or shared post image for brand-aware analysis after products are fetched
  let storyContext = '';
  let storyImageBase64 = null;
  let storyImageContentType = null;
  let storyHints = ''; // any text hints from the source (post title, subtitle)

  // Priority: story reply image > shared post image
  const contextImageUrl = storyImageUrl || sharedPostImageUrl || null;
  if (sharedPostTitle || sharedPostSubtitle) {
    storyHints = [sharedPostTitle, sharedPostSubtitle].filter(Boolean).join(' — ');
  }

  if (contextImageUrl) {
    try {
      console.log(`📖 Downloading context image (${storyImageUrl ? 'story' : 'shared post'})...`);
      const response = await fetch(contextImageUrl);
      if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
      const buffer = await response.arrayBuffer();
      storyImageBase64 = Buffer.from(buffer).toString('base64');
      storyImageContentType = response.headers.get('content-type') || 'image/jpeg';
      console.log('📖 Context image downloaded, will analyze after products are fetched');
    } catch (err) {
      console.error('❌ Context image download failed:', err.message);
      if (storyReply) storyContext = '__no_image__';
    }
  } else if (storyReply) {
    // Story reply but image URL not accessible (expired or private)
    storyContext = '__no_image__';
    console.log('📖 Story reply with no accessible image URL');
  }

  let trace = null;
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

    const { brand_id, access_token: integrationToken } = integration;
    // Brand resolved from integration lookup

    // Try to get a managed long-lived page token, fall back to integrations table token
    let access_token = integrationToken;
    try {
      access_token = await getValidPageToken(brand_id);
      // Using managed page token
    } catch (tokenErr) {
      console.log(`ℹ️  No managed token for brand ${brand_id}, using integrations token`);
    }

    // 2. Fetch knowledge base and products
    const { data: knowledgeBaseRows } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('brand_id', brand_id);

    // Extract situations and size guides from the knowledge base row
    const kbRow = knowledgeBaseRows && knowledgeBaseRows[0];
    const situationsEnabled = kbRow?.situations_enabled || false;
    const situations = kbRow?.situations || [];
    const sizeGuidesEnabled = kbRow?.size_guides_enabled || false;
    const sizeGuides = kbRow?.size_guides || [];

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

    // Brand-aware story analysis — now that we have the product catalog
    if (storyImageBase64 && storyImageContentType) {
      try {
        const productList = (products || []).map(p => p.name).join(', ') || 'no products listed';
        const hintsLine = storyHints ? `\nText visible in the post/story: "${storyHints}"` : '';
        const visionResponse = await openai.chat.completions.create({
          model: 'gpt-4o',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are analyzing an Instagram story or post from a fashion/clothing brand. The brand's products are: ${productList}.${hintsLine}

Look at this image and answer concisely:
1. What is shown? (product type, colors, text overlays, design details — be specific)
2. If one of the brand's listed products appears to be shown, name it exactly. If uncertain, say so.
3. Is this a product showcase, a lifestyle/mood shot, a promotion, or something else?

Do not invent product names. Only match against the listed products above.`
              },
              {
                type: 'image_url',
                image_url: { url: `data:${storyImageContentType};base64,${storyImageBase64}`, detail: 'high' }
              }
            ]
          }]
        });
        storyContext = visionResponse.choices[0].message.content;
        console.log(`📖 Story analysis: ${storyContext}`);

        logUsage({
          brandId: brand_id,
          conversationId: null, // conversation not yet fetched at this point
          messageType: 'story',
          model: 'gpt-4o',
          promptTokens: visionResponse.usage?.prompt_tokens ?? 0,
          completionTokens: visionResponse.usage?.completion_tokens ?? 0,
          totalTokens: visionResponse.usage?.total_tokens ?? 0
        });
      } catch (err) {
        console.error('❌ Story analysis failed:', err.message);
        storyContext = '__no_image__';
      }
    }

    // Transcribe voice note now that we have product names to prime Whisper
    let whisperDurationSeconds = 0;
    if (audioUrl) {
      console.log('🎤 Voice note received, transcribing...');
      const productNames = (products || []).map(p => p.name).join(', ');
      const whisperPrompt = productNames
        ? `Customer service conversation. Brand products: ${productNames}.`
        : 'Customer service conversation.';
      const { text: transcribed, durationSeconds } = await transcribeAudio(audioUrl, whisperPrompt);
      whisperDurationSeconds = durationSeconds;
      if (transcribed) {
        finalMessage = transcribed;
        console.log(`✅ Transcription: "${transcribed}"`);
      } else {
        // Transcription failed — reply directly and skip AI
        console.log('⚠️  Transcription failed, sending fallback reply');
        const fallback = "Sorry, I couldn't catch that voice note! Could you type it out for me? 😊";
        await sendDM(senderId, fallback, access_token);
        return;
      }
    }

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
      current_order: null
    };

    if (!conversation) {
      // Fetch Instagram profile for display in the dashboard
      const profile = await getUserProfile(senderId, access_token);

      const { data: newConv } = await supabase
        .from('conversations')
        .insert({
          brand_id,
          customer_id: senderId,
          customer_name: profile?.name || null,
          customer_username: profile?.username || null,
          platform: 'instagram',
          status: 'active',
          metadata: defaultMetadata
        })
        .select()
        .single();

      conversation = newConv;
    } else if (!conversation.customer_name && !conversation.customer_username) {
      // Backfill profile for existing conversations that don't have it yet
      const profile = await getUserProfile(senderId, access_token);
      if (profile?.name || profile?.username) {
        await supabase
          .from('conversations')
          .update({
            customer_name: profile.name || null,
            customer_username: profile.username || null,
          })
          .eq('id', conversation.id);
        conversation.customer_name = profile.name;
        conversation.customer_username = profile.username;
      }
    }

    // Upload customer image to Supabase Storage for a permanent URL
    let storedImageUrl = null;
    if (effectiveImageUrl) {
      storedImageUrl = await uploadImageToStorage(effectiveImageUrl, brand_id);
    }

    // Log Whisper usage now that we have a conversation ID
    if (audioUrl && whisperDurationSeconds >= 0) {
      logUsage({
        brandId: brand_id,
        conversationId: conversation.id,
        messageType: 'voice',
        model: 'whisper-1',
        audioDurationSeconds: whisperDurationSeconds
      });
    }

    // Load metadata from database (CRITICAL - this is Luna's memory)
    let metadata = defaultMetadata;
    if (conversation?.metadata && typeof conversation.metadata === 'object') {
      metadata = { ...defaultMetadata, ...conversation.metadata };
    }
    // Metadata loaded from DB — skip verbose logging

    // ── Langfuse Tracing ──────────────────────────────────────
    const profile = {
      name: conversation.customer_name || senderId,
      username: conversation.customer_username || null
    };

    trace = langfuse.trace({
      name: 'luna-message',
      userId: senderId,
      sessionId: conversation?.id || senderId,
      metadata: {
        brand_id: brand_id,
        customer_name: profile.name,
        customer_username: profile.username,
        channel: 'instagram',
        has_image: !!effectiveImageUrl,
        has_audio: !!audioUrl,
        metadata_state: JSON.stringify(metadata)
      },
      tags: ['luna', 'instagram', brand_id]
    });

    // Log the incoming customer message
    trace.event({
      name: 'customer-message',
      input: finalMessage || '[Image/Audio]',
      metadata: {
        sender_id: senderId,
        has_image: !!effectiveImageUrl,
        has_audio: !!audioUrl
      }
    });

    // 4. ESCALATION CHECK - Skip AI response if conversation is escalated
    if (conversation.is_escalated) {
      console.log(`🚨 Conversation is escalated (type: ${conversation.escalation_type}) - AI will not respond`);
      console.log(`   Reason: ${conversation.escalation_reason}`);

      // Still save the incoming message for the team to see
      const { data: escalatedMsg } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversation.id,
          sender: 'customer',
          content: finalMessage || null,
          platform_message_id: messageId,
          image_url: storedImageUrl,
        })
        .select('id')
        .single();

      // Track interaction (fire-and-forget)
      trackInteraction({
        brandId: brand_id,
        conversationId: conversation.id,
        customerId: senderId,
        customerUsername: conversation.customer_username,
        messageId: escalatedMsg?.id,
        isEscalated: true,
      });

      // Don't send any reply - let human team handle it
      return;
    }

    // 5. All order collection, refund/exchange flows are now handled by the AI
    //    The AI uses conversation history to track state — no state machine needed

    // 7. Fetch conversation history (last 20 messages)
    const { data: previousMessages } = await supabase
      .from('messages')
      .select('sender, content')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(20);

    // 8. Save incoming message
    const { data: savedMsg } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'customer',
        content: finalMessage || null,
        platform_message_id: messageId,
        image_url: storedImageUrl,
      })
      .select('id')
      .single();

    // Track interaction (fire-and-forget)
    trackInteraction({
      brandId: brand_id,
      conversationId: conversation.id,
      customerId: senderId,
      customerUsername: conversation.customer_username,
      messageId: savedMsg?.id,
    });

    // 9. Map conversation history to OpenAI format
    // Filter out image-only placeholder messages — they have no useful text context
    const IMAGE_PLACEHOLDERS = ['[Image]', '[Image/Audio]', '[Voice Note]', '[Story Reply]'];
    const conversationHistory = (previousMessages || [])
      .filter(msg => !IMAGE_PLACEHOLDERS.includes(msg.content?.trim()))
      .map(msg => ({
        role: msg.sender === 'customer' ? 'user' : 'assistant',
        content: msg.content
      }));

    // 10. Fetch business name and type for system prompt
    const { data: user } = await supabase
      .from('users')
      .select('business_name, brand_id')
      .eq('id', brand_id)
      .maybeSingle();
    const businessName = user?.business_name || 'our business';

    const { data: brand } = await supabase
      .from('brands')
      .select('business_type, brand_description')
      .eq('id', brand_id)
      .maybeSingle();
    const businessType = brand?.business_type || null;
    const brandDescription = brand?.brand_description || null;

    // 11. Generate AI reply
    let aiReply;

    if (effectiveImageUrl) {
      // IMAGE FLOW: Use vector similarity search to find matching products
      console.log('📸 Processing customer image with vector search...');
      const { matches, queryDescription } = await findSimilarProducts(effectiveImageUrl, brand_id, conversation.id);

      // Build the base system prompt using the optimized prompt builder
      const { buildOptimizedPrompt } = require('../lib/prompts/prompt-manager');
      const baseSystemPrompt = buildOptimizedPrompt({
        businessName,
        businessType,
        brandDescription,
        customerMessage: finalMessage || 'Do you have this product?',
        conversationHistory,
        metadata,
        inStockProducts,
        outOfStockProducts,
        knowledgeBaseRows: knowledgeBaseRows || [],
        hasImage: true,
        storyContext,
        situationsEnabled,
        situations,
        sizeGuidesEnabled,
        sizeGuides
      });

      // Build the image system prompt with vector search results appended
      let imageSearchSection = '';
      if (matches && matches.length > 0) {
        const matchList = matches.map(p => {
          if (p.in_stock) {
            return `- ${p.name}: ${p.price} EGP ✅ In Stock (${(p.similarity * 100).toFixed(0)}% visual match)\n  Description: ${p.image_description || 'N/A'}`;
          } else {
            return `- ${p.name}: ❌ NOT currently in stock — do NOT show price, do NOT allow ordering (${(p.similarity * 100).toFixed(0)}% visual match)\n  Description: ${p.image_description || 'N/A'}`;
          }
        }).join('\n\n');

        imageSearchSection = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 IMAGE SEARCH RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The customer sent an image. Based on visual similarity search, these are the most likely matching products:

${matchList}

Customer's image looks like: ${queryDescription}

⛔ STRICT RULES FOR IMAGE MATCHES:
- IN STOCK ✅: confirm the product name, state price and availability, ask if they want to order
- OUT OF STOCK ❌: say the product name only (NO price), say it's not currently available, suggest in-stock alternatives from the catalog. If the customer then tries to order it anyway → firmly say it's unavailable and redirect to what's in stock
- If no match feels right visually, say so honestly — do not force a bad match`;
      }

      const imageSystemPrompt = imageSearchSection
        ? `${baseSystemPrompt}${imageSearchSection}`
        : baseSystemPrompt;

      // Download image and send to vision model
      let imageUserContent;
      try {
        const imgResponse = await fetch(effectiveImageUrl);
        if (!imgResponse.ok) throw new Error(`Failed to download: ${imgResponse.status}`);
        const imgBuffer = await imgResponse.arrayBuffer();
        const imgBase64 = Buffer.from(imgBuffer).toString('base64');
        const imgContentType = imgResponse.headers.get('content-type') || 'image/jpeg';
        imageUserContent = [
          { type: 'text', text: finalMessage || 'Do you have this product?' },
          { type: 'image_url', image_url: { url: `data:${imgContentType};base64,${imgBase64}`, detail: 'low' } }
        ];
      } catch (imgErr) {
        console.error('❌ Failed to attach image to vision request:', imgErr.message);
        imageUserContent = finalMessage || 'The customer sent an image about a product.';
      }

      const imageMessages = [
        { role: 'system', content: imageSystemPrompt },
        ...conversationHistory,
        { role: 'user', content: imageUserContent }
      ];

      // Wrap the OpenAI call with a Langfuse generation span
      const imageGeneration = trace.generation({
        name: 'luna-reply',
        model: 'gpt-4o-mini',
        input: imageMessages,
        metadata: {
          flow: matches && matches.length > 0 ? 'image-match' : 'image-vision',
          awaiting: metadata.awaiting,
          current_order: metadata.current_order,
          collected_info: metadata.collected_info,
          history_length: conversationHistory.length
        }
      });

      const imageStartTime = Date.now();
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: imageMessages,
        max_tokens: 400
      });
      const imageLatency = Date.now() - imageStartTime;

      imageGeneration.end({
        output: completion.choices[0].message.content,
        usage: {
          input: completion.usage?.prompt_tokens,
          output: completion.usage?.completion_tokens,
          total: completion.usage?.total_tokens
        },
        metadata: { latency_ms: imageLatency }
      });

      aiReply = completion.choices[0].message.content;
      console.log(`🤖 Luna reply (image): "${aiReply}"`);

      logUsage({
        brandId: brand_id,
        conversationId: conversation.id,
        messageType: 'image',
        model: 'gpt-4o-mini',
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
        totalTokens: completion.usage?.total_tokens ?? 0
      });

    } else {
      // TEXT FLOW: Normal conversation without image
      // Wrap the text AI call with a Langfuse generation span
      const textGeneration = trace.generation({
        name: 'luna-reply',
        model: 'gpt-4.1',
        input: finalMessage,
        metadata: {
          flow: 'text',
          awaiting: metadata.awaiting,
          current_order: metadata.current_order,
          collected_info: metadata.collected_info,
          history_length: conversationHistory.length
        }
      });

      const textStartTime = Date.now();
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
        storyContext,
        businessType,
        brandDescription,
        situationsEnabled,
        situations,
        sizeGuidesEnabled,
        sizeGuides,
        conversation.id
      );
      const textLatency = Date.now() - textStartTime;

      textGeneration.end({
        output: aiReply,
        metadata: { latency_ms: textLatency }
      });

      console.log(`🤖 Luna reply: "${aiReply}"`);
    }

    // 12. Check if AI returned a PLACE_ORDER JSON
    const orderJsonMatch = aiReply.match(/\{"action"\s*:\s*"PLACE_ORDER".*\}/);

    if (orderJsonMatch) {
      try {
        const orderData = JSON.parse(orderJsonMatch[0]);
        console.log('🎉 Order ready:', JSON.stringify(orderData));

        // Normalize to items array format (backward-compatible with old single-product format)
        if (!orderData.items && orderData.product_name) {
          orderData.items = [{
            variant_id: orderData.variant_id || null,
            product_name: orderData.product_name,
            quantity: orderData.quantity || 1,
            price: orderData.price
          }];
        }

        // Validate required fields
        if (!orderData.items || orderData.items.length === 0 || !orderData.name || !orderData.phone || !orderData.address) {
          throw new Error('Missing required order fields');
        }

        // Calculate total price and build product summary
        const totalPrice = orderData.items.reduce((sum, item) => sum + (item.price * (item.quantity || 1)), 0);
        const productSummary = orderData.items.map(item =>
          `${item.quantity || 1}x ${item.product_name}`
        ).join(', ');

        // Fetch Shopify integration
        const { data: shopifyIntegration } = await supabase
          .from('integrations')
          .select('shopify_shop_domain, access_token')
          .eq('brand_id', brand_id)
          .eq('platform', 'shopify')
          .maybeSingle();

        let confirmationMsg;
        let shopifyOrderNumber = null;

        if (!shopifyIntegration) {
          console.log(`⚠️  No Shopify integration found for brand ${brand_id} - recording order without Shopify`);

          // Save order to DB even without Shopify
          await supabase.from('orders').insert({
            brand_id,
            conversation_id: conversation.id,
            shopify_order_id: null,
            shopify_order_number: null,
            customer_name: orderData.name,
            customer_phone: orderData.phone,
            customer_address: orderData.address,
            product_name: productSummary,
            price: totalPrice,
            currency: 'EGP',
            status: 'pending',
            created_at: new Date().toISOString()
          });

          confirmationMsg = `✅ Your order has been recorded!\n\n• Product: ${productSummary}\n• Price: ${totalPrice} EGP\n• Name: ${orderData.name}\n• Phone: ${orderData.phone}\n• Address: ${orderData.address}\n\nOur team will contact you soon to confirm. Thank you! 🎉`;
        } else {
          const formattedPhone = formatEgyptianPhone(orderData.phone);

          // Build line_items using real variant IDs when available
          const line_items = orderData.items.map(item => {
            if (item.variant_id) {
              // Extract numeric ID from GID format (gid://shopify/ProductVariant/12345 → 12345)
              const numericId = item.variant_id.includes('gid://')
                ? item.variant_id.split('/').pop()
                : item.variant_id;
              return {
                variant_id: parseInt(numericId, 10),
                quantity: item.quantity || 1
              };
            }
            // Fallback for items without variant_id (shouldn't happen with updated prompts)
            return {
              title: item.product_name,
              quantity: item.quantity || 1,
              price: item.price
            };
          });

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
                  line_items,
                  customer: {
                    first_name: orderData.name
                  },
                  shipping_address: {
                    name: orderData.name,
                    address1: orderData.address,
                    city: 'Egypt',      // Shopify requires city to save the address; full address is in address1
                    country: 'EG',
                    country_code: 'EG',
                    phone: formattedPhone
                  },
                  billing_address: {
                    name: orderData.name,
                    address1: orderData.address,
                    city: 'Egypt',
                    country: 'EG',
                    country_code: 'EG',
                    phone: formattedPhone
                  },
                  phone: formattedPhone,
                  financial_status: 'pending',
                  inventory_behaviour: 'decrement_obeying_policy',
                  send_receipt: false,
                  note: 'Order placed via Luna AI agent on Instagram/Messenger'
                }
              })
            }
          );

          const shopifyData = await shopifyResponse.json();

          if (!shopifyResponse.ok) {
            console.error(`❌ Shopify API error: ${shopifyResponse.status}`, shopifyData);

            // Parse Shopify error details into a human-readable message
            let errorDetail = '';
            if (shopifyData?.errors) {
              const errors = shopifyData.errors;
              if (typeof errors === 'string') {
                errorDetail = errors;
              } else {
                const parts = [];
                for (const [field, messages] of Object.entries(errors)) {
                  const msgs = Array.isArray(messages) ? messages.join(', ') : String(messages);
                  parts.push(`${field}: ${msgs}`);
                }
                errorDetail = parts.join(' | ');
              }
            }
            console.error(`❌ Shopify error details: ${errorDetail}`);

            // Build user-facing message based on which field failed
            const errLower = errorDetail.toLowerCase();
            if (errLower.includes('phone')) {
              confirmationMsg = `There's an issue with the phone number you provided. Could you double-check it and send it again? (e.g. 01012345678)`;
            } else if (errLower.includes('address') || errLower.includes('shipping')) {
              confirmationMsg = `There's an issue with the delivery address. Could you send it again with more detail? (street, area, city)`;
            } else if (errLower.includes('email')) {
              confirmationMsg = `There's an issue with the email address. Could you check it and try again?`;
            } else if (errorDetail) {
              confirmationMsg = `There was a problem placing your order: ${errorDetail}. Could you check your details and try again?`;
            } else {
              confirmationMsg = `Sorry, we couldn't place your order right now. Please try again or contact us directly.`;
            }

            await sendDM(senderId, confirmationMsg, access_token);
            await supabase.from('messages').insert({ conversation_id: conversation.id, sender: 'ai', content: confirmationMsg });
            trace.event({
              name: 'action-taken',
              input: { action: 'place_order', order_data: orderData },
              metadata: { order_placed: false, shopify_error: true, error_detail: errorDetail }
            });
            return;
          }

          const shopifyOrder = shopifyData.order;
          const shopifyOrderId = shopifyOrder?.id;
          shopifyOrderNumber = shopifyOrder?.order_number;

          console.log(`✅ Shopify order created: #${shopifyOrderNumber} for ${productSummary}`);

          // Save to Supabase orders table
          await supabase.from('orders').insert({
            brand_id,
            conversation_id: conversation.id,
            shopify_order_id: String(shopifyOrderId),
            shopify_order_number: String(shopifyOrderNumber),
            customer_name: orderData.name,
            customer_phone: orderData.phone,
            customer_address: orderData.address,
            product_name: productSummary,
            price: totalPrice,
            currency: 'EGP',
            status: 'pending',
            created_at: new Date().toISOString()
          });

          confirmationMsg = `✅ Your order has been placed!\n\n• Order #${shopifyOrderNumber}\n• Product: ${productSummary}\n• Price: ${totalPrice} EGP\n• Name: ${orderData.name}\n• Phone: ${orderData.phone}\n• Address: ${orderData.address}\n\nWe'll contact you soon to confirm delivery. Thank you! 🎉`;
        }

        // Send confirmation to customer (not the raw JSON)
        await sendDM(senderId, confirmationMsg, access_token);
        console.log(`✅ Sent order confirmation to ${senderId}`);
        await supabase.from('messages').insert({ conversation_id: conversation.id, sender: 'ai', content: confirmationMsg });

        // Log the order-placed event to Langfuse
        trace.event({
          name: 'order-placed',
          input: orderData,
          output: { shopify_order_number: shopifyOrderNumber },
          level: 'DEFAULT'
        });

        // Reset metadata after successful order
        metadata = { discussed_products: [], current_order: null };
        await supabase.from('conversations').update({ metadata }).eq('id', conversation.id);
        return;

      } catch (e) {
        console.error('Failed to parse order JSON:', e.message);
        // Fall back to asking customer to confirm again
        aiReply = "Could you please confirm your order details one more time?";
      }
    }

    // 12b. Check if AI returned a VALIDATE_ORDER JSON (exchange/refund order validation)
    const validateOrderMatch = aiReply.match(/\{"action"\s*:\s*"VALIDATE_ORDER".*\}/);

    if (validateOrderMatch) {
      try {
        const validateData = JSON.parse(validateOrderMatch[0]);
        console.log('🔍 Order validation requested:', JSON.stringify(validateData));

        const requestedOrderId = (validateData.order_id || '').replace(/^#/, '').trim();
        const requestedName = (validateData.customer_name || '').trim();

        if (!requestedOrderId || !requestedName) {
          throw new Error('Missing order_id or customer_name in VALIDATE_ORDER');
        }

        // Look up order by shopify_order_number for this brand
        // Try multiple formats: "1005", "#1005" — the customer might provide either
        const orderIdVariants = [requestedOrderId, `#${requestedOrderId}`];
        const { data: matchedOrders, error: orderLookupError } = await supabase
          .from('orders')
          .select('*')
          .eq('brand_id', brand_id)
          .in('shopify_order_number', orderIdVariants);

        let validationResult;

        if (orderLookupError) {
          console.error(`❌ Order lookup error:`, orderLookupError);
        }

        if (orderLookupError || !matchedOrders || matchedOrders.length === 0) {
          console.log(`❌ Order not found: ${requestedOrderId} (searched shopify_order_number IN [${orderIdVariants.join(', ')}])`);
          validationResult = `SYSTEM_VALIDATION_RESULT: INVALID — No order found with ID "${requestedOrderId}". Ask the customer to double-check their order number.`;
        } else {
          // Fuzzy name matching — check if any matched order has a similar customer name
          const normalizeStr = (s) => s.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');
          const requestedNameNorm = normalizeStr(requestedName);

          // Simple fuzzy match: check if names are similar (Levenshtein-like tolerance)
          const fuzzyNameMatch = (a, b) => {
            if (a === b) return true;
            if (a.includes(b) || b.includes(a)) return true;
            // Allow up to 2 character differences for names > 4 chars
            if (a.length > 4 && b.length > 4) {
              let differences = 0;
              const longer = a.length >= b.length ? a : b;
              const shorter = a.length < b.length ? a : b;
              for (let i = 0; i < longer.length; i++) {
                if (longer[i] !== shorter[i]) differences++;
              }
              if (Math.abs(a.length - b.length) + differences <= 2) return true;
            }
            return false;
          };

          const matchedOrder = matchedOrders.find(o => {
            const orderName = normalizeStr(o.customer_name || '');
            return fuzzyNameMatch(requestedNameNorm, orderName);
          });

          if (!matchedOrder) {
            console.log(`❌ Name mismatch: "${requestedName}" vs orders: ${matchedOrders.map(o => o.customer_name).join(', ')}`);
            validationResult = `SYSTEM_VALIDATION_RESULT: INVALID — Order #${requestedOrderId} exists but the name "${requestedName}" does not match the name on the order. Ask the customer to check the exact name they used when ordering (there might be a typo).`;
          } else {
            console.log(`✅ Order validated: #${requestedOrderId} for "${matchedOrder.customer_name}"`);

            // Check if there's already an active exchange or refund for this order
            const { data: existingExchanges } = await supabase
              .from('exchanges')
              .select('id, status')
              .eq('brand_id', brand_id)
              .eq('order_id', matchedOrder.id)
              .in('status', ['pending', 'approved', 'shipped']);

            const { data: existingRefunds } = await supabase
              .from('refunds')
              .select('id, status')
              .eq('brand_id', brand_id)
              .eq('order_id', matchedOrder.id)
              .in('status', ['pending', 'approved', 'processed']);

            // Also check by original_order_number in case order_id UUID wasn't set
            const orderIdClean = requestedOrderId.replace(/^#/, '').trim();
            const { data: existingExchangesByNumber } = await supabase
              .from('exchanges')
              .select('id, status')
              .eq('brand_id', brand_id)
              .eq('original_order_number', orderIdClean)
              .in('status', ['pending', 'approved', 'shipped']);

            const { data: existingRefundsByNumber } = await supabase
              .from('refunds')
              .select('id, status')
              .eq('brand_id', brand_id)
              .eq('original_order_number', orderIdClean)
              .in('status', ['pending', 'approved', 'processed']);

            const hasActiveExchange = (existingExchanges && existingExchanges.length > 0) || (existingExchangesByNumber && existingExchangesByNumber.length > 0);
            const hasActiveRefund = (existingRefunds && existingRefunds.length > 0) || (existingRefundsByNumber && existingRefundsByNumber.length > 0);

            if (hasActiveExchange || hasActiveRefund) {
              const activeType = hasActiveExchange ? 'exchange' : 'refund';
              console.log(`⚠️ Order #${requestedOrderId} already has an active ${activeType} request`);
              validationResult = `SYSTEM_VALIDATION_RESULT: ALREADY_EXISTS — Order #${requestedOrderId} already has an active ${activeType} request being processed by the team. Tell the customer that their ${activeType} request for this order is already being handled and the team will be in touch. Do NOT create another request. Do NOT escalate.`;
            } else {
              // Return order details including products
              const productInfo = matchedOrder.product_name || 'Unknown product';
              validationResult = `SYSTEM_VALIDATION_RESULT: VALID — Order #${requestedOrderId} confirmed for "${matchedOrder.customer_name}".
ORDER DETAILS:
- Order Number: #${requestedOrderId}
- Customer Name: ${matchedOrder.customer_name}
- Products Ordered: ${productInfo}
- Order Date: ${matchedOrder.created_at ? new Date(matchedOrder.created_at).toLocaleDateString() : 'N/A'}
- Status: ${matchedOrder.status || 'N/A'}

Now show these products to the customer and proceed with Step 2 of the exchange/refund flow.`;
            }
          }
        }

        // Re-invoke AI with the validation result so Luna can continue the conversation
        console.log(`🔁 Re-invoking AI with validation result...`);

        // Add the validation attempt and result to conversation history for context
        // The validation result is injected as a system message so the AI treats it as internal feedback
        const validationHistory = [
          ...conversationHistory,
          { role: 'user', content: finalMessage },
          { role: 'assistant', content: 'Let me verify your order details...' },
          { role: 'system', content: validationResult }
        ];

        // Force exchange/refund context by using the original customer message
        // (which contained exchange/refund keywords) so the prompt manager includes
        // the exchange/refund prompt in the re-invocation
        const { buildOptimizedPrompt } = require('../lib/prompts/prompt-manager');
        const validationSystemPrompt = buildOptimizedPrompt({
          businessName,
          businessType,
          brandDescription,
          customerMessage: finalMessage,
          conversationHistory: validationHistory,
          metadata,
          inStockProducts,
          outOfStockProducts,
          knowledgeBaseRows: knowledgeBaseRows || [],
          hasImage: false,
          storyContext: '',
          situationsEnabled,
          situations,
          sizeGuidesEnabled,
          sizeGuides
        });

        const validationMessages = [
          { role: 'system', content: validationSystemPrompt },
          ...validationHistory
        ];

        const validationCompletion = await openai.chat.completions.create({
          model: 'gpt-4.1',
          messages: validationMessages,
          max_tokens: 700
        });

        aiReply = validationCompletion.choices[0].message.content;
        console.log(`🤖 Luna reply (post-validation): "${aiReply}"`);

        logUsage({
          brandId: brand_id,
          conversationId: conversation.id,
          messageType: 'text',
          model: 'gpt-4.1',
          promptTokens: validationCompletion.usage?.prompt_tokens ?? 0,
          completionTokens: validationCompletion.usage?.completion_tokens ?? 0,
          totalTokens: validationCompletion.usage?.total_tokens ?? 0
        });

      } catch (e) {
        console.error('Failed to process VALIDATE_ORDER:', e.message);
        aiReply = "Let me check that for you... Could you please confirm your order number and name again?";
      }
    }

    // Log the action taken to Langfuse
    trace.event({
      name: 'action-taken',
      input: { action: orderJsonMatch ? 'place_order' : validateOrderMatch ? 'validate_order' : 'reply', order_data: null },
      metadata: {
        order_placed: false,
        shopify_order_number: null
      }
    });

    // 13. Check for escalation keywords in AI reply
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

      // Parse the collected fields from Luna's summary in the AI reply.
      // Luna is instructed to produce a structured summary before escalating, e.g.:
      //   📋 Exchange Request:
      //   👤 Name: Ahmed Mohamed
      //   🧾 Order ID: #1234
      //   📦 Product: DOVED
      //   📝 Reason: Wrong size
      const parseField = (text, emoji, label) => {
        const pattern = new RegExp(`(?:${emoji}\\s*)?${label}:\\s*(.+)`, 'i');
        const match = text.match(pattern);
        return match ? match[1].replace(/ESCALATE_\w+/gi, '').trim() : null;
      };

      const collectedName    = parseField(aiReply, '👤', 'Name');
      const collectedOrderId = parseField(aiReply, '🧾', 'Order ID');
      const collectedProduct = parseField(aiReply, '📦', 'Product');
      const collectedReason  = parseField(aiReply, '📝', 'Reason');

      // Fallbacks: use conversation metadata or the customer's last message
      const resolvedName    = collectedName    || conversation.customer_name || null;
      const resolvedOrderId = collectedOrderId || null;
      const resolvedProduct = collectedProduct || metadata.current_order?.product_name || null;
      const resolvedReason  = collectedReason  || finalMessage || null;

      console.log(`📋 Escalation data — name: "${resolvedName}", orderId: "${resolvedOrderId}", product: "${resolvedProduct}", reason: "${resolvedReason}"`);

      // Look up the actual order UUID from the orders table using the shopify_order_number
      let resolvedOrderUUID = null;
      if (resolvedOrderId) {
        const orderIdClean = resolvedOrderId.replace(/^#/, '').trim();
        const { data: orderRow } = await supabase
          .from('orders')
          .select('id')
          .eq('brand_id', brand_id)
          .in('shopify_order_number', [orderIdClean, `#${orderIdClean}`])
          .maybeSingle();
        resolvedOrderUUID = orderRow?.id || null;
      }

      // Auto-create refund/exchange record based on type
      if (escalationCheck.type === 'refund') {
        const { data: refundData, error: refundError } = await supabase.from('refunds').insert({
          brand_id,
          conversation_id: conversation.id,
          customer_id: senderId,
          customer_name: resolvedName,
          order_id: resolvedOrderUUID,
          original_order_number: resolvedOrderId,
          product_name: resolvedProduct,
          order_amount: metadata.current_order?.price || null,
          refund_amount: metadata.current_order?.price || null,
          refund_reason: 'other',
          refund_reason_details: resolvedReason,
          status: 'pending'
        }).select().single();

        if (refundError) {
          console.error('❌ Failed to create refund record:', refundError);
        } else {
          console.log('✅ Auto-created refund record:', refundData.id);
        }
      }

      if (escalationCheck.type === 'exchange') {
        const { data: exchangeData, error: exchangeError } = await supabase.from('exchanges').insert({
          brand_id,
          conversation_id: conversation.id,
          customer_id: senderId,
          customer_name: resolvedName,
          order_id: resolvedOrderUUID,
          original_order_number: resolvedOrderId,
          original_product_name: resolvedProduct,
          original_size: null,
          exchange_reason: 'other',
          exchange_reason_details: resolvedReason,
          status: 'pending'
        }).select().single();

        if (exchangeError) {
          console.error('❌ Failed to create exchange record:', exchangeError);
        } else {
          console.log('✅ Auto-created exchange record:', exchangeData.id);
        }
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

    // 14. Update discussed products from AI reply
    metadata = updateProductTracking(aiReply, metadata, inStockProducts);

    // 15. Send reply via Meta API
    if (aiReply) {
      // If size guides are active, check if the CUSTOMER message was size-related and send chart(s)
      // Skip size chart sending during exchange/refund flows (words like "fit", "size", "small" appear naturally)
      const isExchangeRefundFlow = (conversationHistory || []).some(m =>
        /exchange|refund|swap|replace|return|تبديل|استرجاع/i.test(m.content || '')
      ) || /exchange|refund|swap|replace|return|تبديل|استرجاع/i.test(finalMessage || '');
      if (sizeGuidesEnabled && sizeGuides && sizeGuides.length > 0 && !escalationCheck.shouldEscalate && !isExchangeRefundFlow) {
        console.log(`📏 Size guides active (${sizeGuides.length} total). Checking customer message for size intent...`);
        // Only guides that have a real public HTTP URL (never base64/data URIs)
        const validGuides = sizeGuides.filter(g => g.image_url && g.image_url.startsWith('http'));
        console.log(`📏 Valid guides with HTTP image URLs: ${validGuides.length}`);
        sizeGuides.forEach(g => console.log(`   - "${g.product_name}": image_url starts with "${(g.image_url || '').substring(0, 30)}"`));

        if (validGuides.length > 0) {
          const msgLower = (finalMessage || '').toLowerCase();
          const sizeKeywords = ['size', 'sizing', 'fit', 'fits', 'chart', 'measurement', 'measure',
            'length', 'chest', 'waist', 'hips', 'shoulder', 'مقاس', 'مقاسات', 'قياس', 'قياسات', 'طول'];
          const isSizeQuestion = sizeKeywords.some(kw => msgLower.includes(kw));
          console.log(`📏 isSizeQuestion: ${isSizeQuestion} (message: "${finalMessage}")`);

          if (isSizeQuestion) {
            // Match by any product name in the customer message, fall back to all guides
            let guidesToSend = validGuides;
            if (validGuides.length > 1) {
              const matched = validGuides.filter(g => {
                const names = Array.isArray(g.product_names) && g.product_names.length > 0
                  ? g.product_names
                  : (g.product_name ? [g.product_name] : []);
                return names.some(n => msgLower.includes(n.toLowerCase()));
              });
              if (matched.length > 0) guidesToSend = matched;
            }

            for (const guide of guidesToSend) {
              try {
                console.log(`📏 Sending size chart image: ${guide.image_url}`);
                await sendImageDM(senderId, guide.image_url, access_token);
                console.log(`📏 Sent size chart for "${guide.product_name}" to ${senderId}`);
              } catch (imgErr) {
                console.error(`❌ Failed to send size chart image: ${imgErr.message}`);
              }
            }
          }
        } else {
          console.log(`📏 No valid HTTP image URLs found — image send skipped`);
        }
      }

      await sendDM(senderId, aiReply, access_token);
    }

    // 16. Save AI reply to database
    await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender: 'ai',
        content: aiReply,
      });

    // 17. Save updated metadata (CRITICAL - this preserves product tracking across messages)
    await supabase
      .from('conversations')
      .update({ metadata })
      .eq('id', conversation.id);

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);

    // Log the error to Langfuse
    if (trace) {
      trace.event({
        name: 'error',
        input: error.message,
        level: 'ERROR'
      });
    }

    // Send fallback message
    try {
      // Try managed token first for fallback DM
      let fallbackToken = null;
      try {
        const { data: integration } = await supabase
          .from('integrations')
          .select('brand_id, access_token')
          .eq('instagram_page_id', recipientId)
          .eq('platform', 'instagram')
          .maybeSingle();

        if (integration?.brand_id) {
          try {
            fallbackToken = await getValidPageToken(integration.brand_id);
          } catch {
            fallbackToken = integration?.access_token;
          }
        }
      } catch (_) {}

      if (fallbackToken) {
        await sendDM(
          senderId,
          "Sorry, I'm having trouble processing your message right now. Please try again later or contact our support team.",
          fallbackToken
        );
      }
    } catch (fallbackError) {
      console.error(`❌ Error: ${fallbackError.message}`);
    }
  } finally {
    // Always flush Langfuse to ensure all events are sent
    await langfuse.flushAsync();
  }
}

/**
 * Update product tracking in metadata based on AI reply
 * Tracks which products have been discussed in the conversation
 */
function updateProductTracking(aiReply, metadata, products) {
  try {
    const lowerCaseReply = aiReply.toLowerCase();

    (products || []).forEach(product => {
      if (lowerCaseReply.includes(product.name.toLowerCase())) {
        const alreadyDiscussed = metadata.discussed_products.find(
          p => p.name === product.name
        );
        if (!alreadyDiscussed) {
          metadata.discussed_products.push({
            index: metadata.discussed_products.length + 1,
            name: product.name,
            price: product.price
          });
        }
      }
    });

    return metadata;
  } catch (error) {
    console.error(`❌ Error updating product tracking: ${error.message}`);
    return metadata;
  }
}

module.exports = router;
