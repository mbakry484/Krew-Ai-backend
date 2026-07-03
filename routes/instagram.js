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
const { shopifyGraphQL, getValidAccessToken, getShopifyOrderByNumber, SHOPIFY_API_VERSION } = require('../lib/shopify');
const { runStepDetector, postAiReplyTransition, postValidationTransition } = require('../lib/flow-detector');
const { downloadImageAsBase64, describeImageForSearch, embedText } = require('../lib/embeddings');
const { garmentTypePenalty } = require('../lib/garment-vocab');

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

// Message batching (debounce): customers often send several messages in a burst
// (follow-up texts, voice notes, images — e.g. a question whose image loads a
// moment after the text). Instead of replying to each message individually,
// buffer them per sender and reset a cooldown timer on every new message. When
// the customer goes quiet for BATCH_WAIT_MS, the whole batch is processed as
// ONE combined message so Luna answers with full context.
// Key: senderId, Value: { events: [messaging...], recipientId, timer }
const messageBuffers = new Map();
const BATCH_WAIT_MS = parseInt(process.env.MESSAGE_BATCH_WAIT_MS || '10000', 10);

/**
 * Find products similar to a customer's image using vector similarity search
 * @param {string} imageUrl - URL of the customer's image
 * @param {string} brandId - Brand ID to search within
 * @returns {Promise<{matches: Array, queryDescription: string|null}>}
 */
async function findSimilarProducts(imageUrl, brandId, conversationId = null) {
  try {
    // Describe the customer's image with the SAME structured vision prompt and
    // schema used when indexing product images (lib/embeddings.js), so both
    // sides produce embeddings in the same vector space.
    const image = await downloadImageAsBase64(imageUrl);
    const described = await describeImageForSearch(image);
    const queryDescription = described.summary;
    const queryType = described.garmentType;
    console.log(`🔍 Customer image described as: ${described.embeddingText}`);
    console.log(`👕 Query garment type: ${queryType || 'unknown'}`);

    logUsage({
      brandId,
      conversationId,
      messageType: 'image',
      model: 'gpt-4o',
      promptTokens: described.usage?.prompt_tokens ?? 0,
      completionTokens: described.usage?.completion_tokens ?? 0,
      totalTokens: described.usage?.total_tokens ?? 0
    });

    // Embed the canonical attribute string — same format as stored product embeddings
    const queryEmbedding = await embedText(described.embeddingText);

    // Search for similar products using pgvector.
    // Fetch a wide candidate pool with a low raw threshold — the real ranking
    // happens client-side after applying the garment-type penalty.
    const { data: rawMatches, error } = await supabase.rpc('match_products_by_embedding', {
      query_embedding: queryEmbedding,
      match_brand_id: brandId,
      match_threshold: 0.3,
      match_count: 10
    });

    if (error) {
      console.error('❌ Vector search error:', error.message);
      return { matches: [], queryDescription };
    }

    // Two-stage ranking:
    // 1) cosine similarity from pgvector (visual/attribute closeness)
    // 2) soft garment-type penalty — a polo must not beat a tank top for a
    //    tank-top query just because the colors/texture align. Soft (not a
    //    hard filter) so one mislabeled type can't hide a genuinely good match.
    // Threshold applies to the ADJUSTED score. Calibrated against the
    // structured description scheme (live-measured 2026-07-03): exact product
    // ~0.89 raw, plausible same-type alternative ~0.76, cross-category ~0.42
    // raw → ~0.12 after penalty. 0.60 keeps genuine matches and alternatives,
    // drops different-type items. Env-tunable without redeploy.
    const SIMILARITY_THRESHOLD = parseFloat(process.env.IMAGE_MATCH_THRESHOLD || '0.60');
    const matches = (rawMatches || [])
      .map(m => {
        const penalty = garmentTypePenalty(queryType, m.garment_type || null);
        return { ...m, raw_similarity: m.similarity, similarity: m.similarity - penalty };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .filter(m => m.similarity >= SIMILARITY_THRESHOLD)
      .slice(0, 3);

    const best = matches[0]?.similarity?.toFixed(2) || 'none';
    console.log(`🎯 Found ${matches.length} confident matches above ${SIMILARITY_THRESHOLD} (best: ${best})`);
    if (matches.length > 0) {
      matches.forEach(m => {
        const penaltyNote = m.raw_similarity !== m.similarity
          ? ` (raw: ${(m.raw_similarity * 100).toFixed(1)}%, type mismatch: ${m.garment_type || '?'} vs ${queryType})`
          : '';
        console.log(`   • ${m.name} | similarity: ${(m.similarity * 100).toFixed(1)}%${penaltyNote} | type: ${m.garment_type || 'unknown'} | in_stock: ${m.in_stock}`);
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
 * Fetch customer's Instagram profile (name and username)
 */
async function getCustomerProfile(senderId, accessToken) {
  try {
    const response = await fetch(
      `https://graph.instagram.com/v21.0/${senderId}?fields=name,username&access_token=${accessToken}`
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

        // MESSAGE BATCHING (debounce):
        // Buffer this event and (re)start the sender's cooldown timer. Any
        // follow-up message within BATCH_WAIT_MS joins the same batch and
        // resets the timer, so a burst of texts/voice notes/images gets ONE
        // combined reply — and an image that loads after its accompanying
        // text still lands in the same batch.
        const buffer = messageBuffers.get(senderId) || { events: [], recipientId };
        if (buffer.timer) clearTimeout(buffer.timer);
        buffer.events.push(messaging);
        buffer.recipientId = recipientId;
        buffer.timer = setTimeout(() => {
          messageBuffers.delete(senderId);
          console.log(`⏰ Batch window closed for ${senderId} — processing ${buffer.events.length} message(s)`);
          handleIncomingMessage(buffer.events, buffer.recipientId).catch(err =>
            console.error(`❌ Batch processing error: ${err.message}`)
          );
        }, BATCH_WAIT_MS);
        messageBuffers.set(senderId, buffer);
        console.log(`⏳ Batched message ${buffer.events.length} from ${senderId} — waiting ${BATCH_WAIT_MS / 1000}s for follow-ups`);
      }
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  } finally {
    res.sendStatus(200);
  }
});

/**
 * Handle a batch of incoming Instagram DMs from one sender.
 * Receives every message collected during the batching window (text, voice
 * notes, images, story replies, shared posts) and produces ONE combined reply,
 * preserving the order the customer sent things in.
 */
async function handleIncomingMessage(messagingEvents, recipientId) {
  const events = Array.isArray(messagingEvents) ? messagingEvents : [messagingEvents];
  const senderId = events[0].sender.id;
  const messageId = events[events.length - 1].message?.mid;

  // Decompose the batch into ordered content parts so the combined message
  // keeps its sequence (e.g. "do you have this?" followed by the image).
  // Each part: { kind: 'text'|'audio'|'image', text, url }
  // Voice-note parts get their text filled in after transcription (which runs
  // later, once products are fetched, so Whisper can be primed with product names).
  const parts = [];
  const imageUrls = []; // direct image attachments only (for vector search)
  let storyReply = null;
  let sharedPost = null;

  for (const ev of events) {
    const msg = ev.message || {};
    const atts = msg.attachments || [];

    // Detect story replies
    if (msg.reply_to?.story) storyReply = msg.reply_to.story;

    // Detect shared Instagram posts (template type)
    // Shared posts are the brand's own content — treat them like story replies
    // (context analysis), NOT like a customer's product search image (vector search).
    const template = atts.find(a => a.type === 'template');
    if (template) {
      const el = template.payload?.elements?.[0] || {};
      sharedPost = {
        imageUrl: el.image_url || el.url || null,
        title: el.title || null,
        subtitle: el.subtitle || null
      };
    }

    if (msg.text) parts.push({ kind: 'text', text: msg.text, url: null });

    for (const att of atts) {
      if (att.type === 'image' && att.payload?.url) {
        parts.push({ kind: 'image', text: null, url: att.payload.url });
        imageUrls.push(att.payload.url);
      } else if (att.type === 'audio' && att.payload?.url) {
        parts.push({ kind: 'audio', text: null, url: att.payload.url });
      }
    }
  }

  const hasAudio = parts.some(p => p.kind === 'audio');
  const sharedPostImageUrl = sharedPost?.imageUrl || null;
  const sharedPostTitle = sharedPost?.title || null;
  const sharedPostSubtitle = sharedPost?.subtitle || null;
  const storyImageUrl = storyReply?.url || null;
  const storyId = storyReply?.id || null;

  if (events.length > 1) {
    console.log(`📦 Processing batch of ${events.length} messages from ${senderId}`);
  }
  if (sharedPostImageUrl) {
    console.log(`📤 Customer shared a brand post: "${sharedPostTitle || 'no title'}"`);
  }
  if (storyReply) {
    console.log(`📖 Customer replied to story: ${storyId}`);
  }

  // Guard: ignore batches with no content
  if (parts.length === 0 && !storyReply && !sharedPostImageUrl) {
    console.log(`ℹ️  Ignoring event with no content from ${senderId}`);
    return;
  }

  // Combined customer message: all text + transcribed voice parts, in order.
  // Built for real after transcription; story-reply default applied there too.
  const buildFinalMessage = () => parts.map(p => p.text).filter(Boolean).join('\n');
  let finalMessage = buildFinalMessage();
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
      .select('name, price, variants, image_url, shopify_product_id, in_stock, handle, online_store_url')
      .eq('brand_id', brand_id)
      .not('price', 'is', null)
      .gt('price', 0)
      .order('name', { ascending: true });

    // Separate into available and unavailable
    const inStockProducts = products?.filter(p => p.in_stock) || [];
    const outOfStockProducts = products?.filter(p => !p.in_stock) || [];

    // Fetch the brand's published storefront URL (Shopify integration) so Luna can
    // share clickable product links instead of listing 100+ products in the DM.
    const { data: shopifyIntegration } = await supabase
      .from('integrations')
      .select('storefront_url')
      .eq('brand_id', brand_id)
      .eq('platform', 'shopify')
      .maybeSingle();
    const storefrontUrl = shopifyIntegration?.storefront_url || null;

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

    // Transcribe voice notes now that we have product names to prime Whisper
    let whisperDurationSeconds = 0;
    const audioParts = parts.filter(p => p.kind === 'audio');
    if (audioParts.length > 0) {
      console.log(`🎤 ${audioParts.length} voice note(s) received, transcribing...`);
      const productNames = (products || []).map(p => p.name).join(', ');
      const whisperPrompt = productNames
        ? `Customer service conversation. Brand products: ${productNames}.`
        : 'Customer service conversation.';
      for (const part of audioParts) {
        const { text: transcribed, durationSeconds } = await transcribeAudio(part.url, whisperPrompt);
        whisperDurationSeconds += durationSeconds;
        if (transcribed) {
          part.text = transcribed;
          console.log(`✅ Transcription: "${transcribed}"`);
        }
      }

      // If the batch had NO other usable content and every transcription failed,
      // reply directly and skip AI
      const hasUsableContent = parts.some(p => p.text) || imageUrls.length > 0 || storyReply || sharedPostImageUrl;
      if (!hasUsableContent) {
        console.log('⚠️  Transcription failed, sending fallback reply');
        const fallback = "Sorry, I couldn't catch that voice note! Could you type it out for me? 😊";
        await sendDM(senderId, fallback, access_token);
        return;
      }

      // Rebuild the combined message now that transcripts are in place
      finalMessage = buildFinalMessage();
      if (!finalMessage && storyReply && !sharedPostImageUrl) {
        finalMessage = 'The customer replied to your story without adding text.';
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
      current_order: null,
      // --- flow-state fields (Phase 1) ---
      flow: null,                  // 'exchange' | 'refund' | 'order' | null
      step: null,                  // step name within the flow
      slots: {},                   // { order_id, customer_name, item, reason, replacement }
      exchange_suggested: false,   // latch: once true, never suggest exchange again
      no_progress_count: 0,        // increments when no slot filled / step unchanged
      last_replies: []             // last 3 outgoing AI replies (for repetition detection)
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

    // Upload customer images to Supabase Storage for permanent URLs
    const storedImageUrls = [];
    for (const url of imageUrls) {
      storedImageUrls.push(await uploadImageToStorage(url, brand_id));
    }

    // Build one message row per content part so the dashboard shows the
    // conversation exactly as the customer sent it (texts, transcripts, images)
    const buildCustomerMessageRows = () => {
      const rows = [];
      let imgIdx = 0;
      for (const part of parts) {
        if (part.kind === 'image') {
          rows.push({
            conversation_id: conversation.id,
            sender: 'customer',
            content: null,
            image_url: storedImageUrls[imgIdx++] || part.url
          });
        } else if (part.text) {
          rows.push({
            conversation_id: conversation.id,
            sender: 'customer',
            content: part.text,
            image_url: null
          });
        }
      }
      if (rows.length === 0) {
        rows.push({
          conversation_id: conversation.id,
          sender: 'customer',
          content: finalMessage || null,
          image_url: null
        });
      }
      rows[0].platform_message_id = messageId;
      return rows;
    };

    // Log Whisper usage now that we have a conversation ID
    if (audioParts.length > 0) {
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
        has_image: imageUrls.length > 0,
        has_audio: hasAudio,
        batch_size: events.length,
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
        has_image: imageUrls.length > 0,
        has_audio: hasAudio,
        batch_size: events.length
      }
    });

    // 4a. GLOBAL LUNA CHECK - Skip AI response if Luna is globally disabled for this brand
    const { data: brandSettings } = await supabase
      .from('brands')
      .select('luna_global_enabled')
      .eq('id', brand_id)
      .single();

    if (brandSettings && brandSettings.luna_global_enabled === false) {
      console.log(`⏸️ Luna is globally disabled for brand ${brand_id} - AI will not respond`);

      // Still save the incoming messages for the team to see
      await supabase
        .from('messages')
        .insert(buildCustomerMessageRows());

      return;
    }

    // 4b. ESCALATION CHECK - Skip AI response if conversation is escalated
    if (conversation.is_escalated) {
      console.log(`🚨 Conversation is escalated (type: ${conversation.escalation_type}) - AI will not respond`);
      console.log(`   Reason: ${conversation.escalation_reason}`);

      // Still save the incoming messages for the team to see
      const { data: escalatedMsgs } = await supabase
        .from('messages')
        .insert(buildCustomerMessageRows())
        .select('id');

      // Track interaction (fire-and-forget)
      trackInteraction({
        brandId: brand_id,
        conversationId: conversation.id,
        customerId: senderId,
        customerUsername: conversation.customer_username,
        messageId: escalatedMsgs?.[escalatedMsgs.length - 1]?.id,
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

    // 8. Save incoming messages (one row per content part, in order)
    const { data: savedMsgs } = await supabase
      .from('messages')
      .insert(buildCustomerMessageRows())
      .select('id');

    // Track interaction (fire-and-forget)
    trackInteraction({
      brandId: brand_id,
      conversationId: conversation.id,
      customerId: senderId,
      customerUsername: conversation.customer_username,
      messageId: savedMsgs?.[savedMsgs.length - 1]?.id,
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

    // Snapshot flow state BEFORE step detector (used by no-progress counter in post-processing).
    // Must be taken before runStepDetector so that step advances count as progress.
    const stepBefore = metadata.step;
    const slotsSnapshotBefore = JSON.stringify(metadata.slots || {});

    // 10b. Run flow/step detector (Phase 4) — sets metadata.flow, metadata.step, metadata.slots
    await runStepDetector(finalMessage, metadata);

    // 11. Generate AI reply
    let aiReply;

    if (imageUrls.length > 0) {
      // IMAGE FLOW: Use vector similarity search to find matching products
      // Cap the number of images per batch to keep vision costs bounded
      const searchImageUrls = imageUrls.slice(0, 3);
      console.log(`📸 Processing ${searchImageUrls.length} customer image(s) with vector search...`);
      let matches = [];
      const queryDescriptions = [];
      for (const url of searchImageUrls) {
        const result = await findSimilarProducts(url, brand_id, conversation.id);
        matches.push(...(result.matches || []));
        if (result.queryDescription) queryDescriptions.push(result.queryDescription);
      }
      // Dedupe matches across images by product name, keeping the strongest
      const matchByName = new Map();
      for (const m of matches) {
        const prev = matchByName.get(m.name);
        if (!prev || m.similarity > prev.similarity) matchByName.set(m.name, m);
      }
      matches = [...matchByName.values()].sort((a, b) => b.similarity - a.similarity).slice(0, 4);
      const queryDescription = queryDescriptions.join(' | ') || null;

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
        sizeGuides,
        storefrontUrl
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
The customer sent ${searchImageUrls.length > 1 ? `${searchImageUrls.length} images` : 'an image'}. Based on visual similarity search, these are the most likely matching products:

${matchList}

Customer's image${searchImageUrls.length > 1 ? 's look' : ' looks'} like: ${queryDescription}

⛔ STRICT RULES FOR IMAGE MATCHES:
- IN STOCK ✅: confirm the product name, state price and availability, ask if they want to order
- OUT OF STOCK ❌: say the product name only (NO price), say it's not currently available, suggest in-stock alternatives from the catalog. If the customer then tries to order it anyway → firmly say it's unavailable and redirect to what's in stock
- If no match feels right visually, say so honestly — do not force a bad match`;
      }

      const imageSystemPrompt = imageSearchSection
        ? `${baseSystemPrompt}${imageSearchSection}`
        : baseSystemPrompt;

      // Download images and send to vision model (all images in the batch)
      let imageUserContent;
      const imageContents = [];
      for (const url of searchImageUrls) {
        try {
          const imgResponse = await fetch(url);
          if (!imgResponse.ok) throw new Error(`Failed to download: ${imgResponse.status}`);
          const imgBuffer = await imgResponse.arrayBuffer();
          const imgBase64 = Buffer.from(imgBuffer).toString('base64');
          const imgContentType = imgResponse.headers.get('content-type') || 'image/jpeg';
          imageContents.push({
            type: 'image_url',
            image_url: { url: `data:${imgContentType};base64,${imgBase64}`, detail: 'low' }
          });
        } catch (imgErr) {
          console.error('❌ Failed to attach image to vision request:', imgErr.message);
        }
      }
      imageUserContent = imageContents.length > 0
        ? [
            { type: 'text', text: finalMessage || 'Do you have this product?' },
            ...imageContents
          ]
        : (finalMessage || 'The customer sent an image about a product.');

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
        conversation.id,
        storefrontUrl
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

        // Fetch Shopify integration (include refresh fields for token rotation)
        const { data: shopifyIntegration } = await supabase
          .from('integrations')
          .select('shopify_shop_domain, access_token, refresh_token, token_expires_at')
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

          // Build lineItems for GraphQL — ensure GID format for variant IDs
          const lineItems = orderData.items.map(item => {
            if (item.variant_id) {
              const variantGid = item.variant_id.toString().includes('gid://')
                ? item.variant_id
                : `gid://shopify/ProductVariant/${item.variant_id}`;
              return {
                variantId: variantGid,
                quantity: item.quantity || 1
              };
            }
            // Fallback for items without variant_id
            return {
              title: item.product_name,
              quantity: item.quantity || 1,
              priceSet: { shopMoney: { amount: String(item.price), currencyCode: 'EGP' } }
            };
          });

          const orderCreateMutation = `
            mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
              orderCreate(order: $order, options: $options) {
                userErrors {
                  field
                  message
                }
                order {
                  id
                  name
                }
              }
            }
          `;

          const orderVariables = {
            order: {
              lineItems,
              customer: {
                toUpsert: {
                  firstName: orderData.name,
                  phone: formattedPhone,
                  email: `${formattedPhone.replace(/\+/g, '')}@instagram.placeholder`,
                },
              },
              shippingAddress: {
                firstName: orderData.name,
                address1: orderData.address,
                city: 'Egypt',
                countryCode: 'EG',
                phone: formattedPhone,
              },
              billingAddress: {
                firstName: orderData.name,
                address1: orderData.address,
                city: 'Egypt',
                countryCode: 'EG',
                phone: formattedPhone,
              },
              phone: formattedPhone,
              financialStatus: 'PENDING',
              note: 'Order placed via Luna AI agent on Instagram/Messenger',
            },
            options: {
              inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
              sendReceipt: false,
            },
          };

          // Get a valid (non-expired) access token
          const validToken = await getValidAccessToken(shopifyIntegration);
          const shopifyData = await shopifyGraphQL(
            shopifyIntegration.shopify_shop_domain,
            validToken,
            orderCreateMutation,
            orderVariables
          );

          // Debug: log the full Shopify response to diagnose missing order fields
          console.log('🔍 Shopify orderCreate full response:', JSON.stringify(shopifyData, null, 2));

          // Check for top-level GraphQL errors (access/scope issues)
          if (shopifyData?.errors && shopifyData.errors.length > 0) {
            console.error('❌ Shopify GraphQL top-level errors:', JSON.stringify(shopifyData.errors));
          }

          const userErrors = shopifyData?.data?.orderCreate?.userErrors;
          if (userErrors && userErrors.length > 0) {
            const errorDetail = userErrors.map(e => `${(e.field || []).join('.')}: ${e.message}`).join(' | ');
            console.error(`❌ Shopify GraphQL orderCreate errors:`, errorDetail);

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

          const shopifyOrder = shopifyData?.data?.orderCreate?.order;
          if (!shopifyOrder) {
            console.error('❌ Shopify orderCreate returned null order. Full response:', JSON.stringify(shopifyData, null, 2));
            confirmationMsg = `Sorry, we couldn't place your order right now. Please try again or contact us directly.`;
            await sendDM(senderId, confirmationMsg, access_token);
            await supabase.from('messages').insert({ conversation_id: conversation.id, sender: 'ai', content: confirmationMsg });
            return;
          }
          const shopifyOrderId = shopifyOrder.id;
          shopifyOrderNumber = shopifyOrder.name;

          console.log(`✅ Shopify order created: ${shopifyOrderNumber} for ${productSummary}`);

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

          confirmationMsg = `✅ Your order has been placed!\n\n• Order ${shopifyOrderNumber}\n• Product: ${productSummary}\n• Price: ${totalPrice} EGP\n• Name: ${orderData.name}\n• Phone: ${orderData.phone}\n• Address: ${orderData.address}\n\nWe'll contact you soon to confirm delivery. Thank you! 🎉`;
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

        // Reset metadata after successful order (full shape including flow-state fields)
        metadata = {
          discussed_products: [],
          current_order: null,
          flow: null,
          step: null,
          slots: {},
          exchange_suggested: false,
          no_progress_count: 0,
          last_replies: []
        };
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

        // If not found locally, try Shopify API as fallback
        let shopifyOrder = null;
        if (orderLookupError || !matchedOrders || matchedOrders.length === 0) {
          console.log(`ℹ️ Order not found locally: ${requestedOrderId} — trying Shopify API...`);
          try {
            const { data: shopifyIntegration } = await supabase
              .from('integrations')
              .select('shopify_shop_domain, access_token, refresh_token, token_expires_at')
              .eq('brand_id', brand_id)
              .eq('platform', 'shopify')
              .maybeSingle();

            if (shopifyIntegration) {
              const validToken = await getValidAccessToken(shopifyIntegration);
              shopifyOrder = await getShopifyOrderByNumber(
                shopifyIntegration.shopify_shop_domain,
                validToken,
                requestedOrderId
              );
            }
          } catch (shopifyErr) {
            console.error(`❌ Shopify order lookup failed:`, shopifyErr.message);
          }
        }

        if ((orderLookupError || !matchedOrders || matchedOrders.length === 0) && !shopifyOrder) {
          console.log(`❌ Order not found: ${requestedOrderId} (searched local DB and Shopify API)`);
          validationResult = `SYSTEM_VALIDATION_RESULT: INVALID — No order found with ID "${requestedOrderId}". Ask the customer to double-check their order number.`;
        } else if (shopifyOrder) {
          // Validate name against Shopify order
          const normalizeStr = (s) => s.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');
          const requestedNameNorm = normalizeStr(requestedName);
          const shopifyNameNorm = normalizeStr(shopifyOrder.customer_name || '');

          const fuzzyNameMatch = (a, b) => {
            if (a === b) return true;
            if (a.includes(b) || b.includes(a)) return true;
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

          if (!shopifyOrder.customer_name || !fuzzyNameMatch(requestedNameNorm, shopifyNameNorm)) {
            console.log(`❌ Name mismatch (Shopify): "${requestedName}" vs "${shopifyOrder.customer_name}"`);
            validationResult = `SYSTEM_VALIDATION_RESULT: INVALID — Order ${shopifyOrder.order_number} exists but the name "${requestedName}" does not match the name on the order. Ask the customer to check the exact name they used when ordering (there might be a typo).`;
          } else {
            console.log(`✅ Order validated via Shopify API: ${shopifyOrder.order_number} for "${shopifyOrder.customer_name}"`);

            // Check for existing active exchanges/refunds by order number
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

            const hasActiveExchange = existingExchangesByNumber && existingExchangesByNumber.length > 0;
            const hasActiveRefund = existingRefundsByNumber && existingRefundsByNumber.length > 0;

            if (hasActiveExchange || hasActiveRefund) {
              const activeType = hasActiveExchange ? 'exchange' : 'refund';
              console.log(`⚠️ Order ${shopifyOrder.order_number} already has an active ${activeType} request`);
              validationResult = `SYSTEM_VALIDATION_RESULT: ALREADY_EXISTS — Order ${shopifyOrder.order_number} already has an active ${activeType} request being processed by the team. Tell the customer that their ${activeType} request for this order is already being handled and the team will be in touch. Do NOT create another request. Do NOT escalate.`;
            } else {
              const productInfo = shopifyOrder.line_items.map(li => `${li.quantity}x ${li.title}`).join(', ');
              validationResult = `SYSTEM_VALIDATION_RESULT: VALID — Order ${shopifyOrder.order_number} confirmed for "${shopifyOrder.customer_name}".
ORDER DETAILS:
- Order Number: ${shopifyOrder.order_number}
- Customer Name: ${shopifyOrder.customer_name}
- Products Ordered: ${productInfo}
- Order Date: ${new Date(shopifyOrder.created_at).toLocaleDateString()}
- Financial Status: ${shopifyOrder.financial_status || 'N/A'}
- Fulfillment Status: ${shopifyOrder.fulfillment_status || 'N/A'}

Now show these products to the customer and proceed with Step 2 of the exchange/refund flow.`;
            }
          }
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

        // Advance step based on validation result (Phase 4)
        postValidationTransition(validationResult, metadata);

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
          sizeGuides,
          storefrontUrl
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

        // Post-AI transition for validation re-invocation (Phase 4)
        postAiReplyTransition(aiReply, metadata);

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

      // Fallbacks: use slots (Phase 4), then conversation metadata, then customer's last message
      const resolvedName    = collectedName    || metadata.slots?.customer_name || conversation.customer_name || null;
      const resolvedOrderId = collectedOrderId || metadata.slots?.order_id || null;
      const slotsItem = metadata.slots?.item && metadata.slots.item !== '__pending_ai_parse__' ? metadata.slots.item : null;
      const slotsReason = metadata.slots?.reason && metadata.slots.reason !== '__pending_ai_parse__' ? metadata.slots.reason : null;
      const resolvedProduct = collectedProduct || slotsItem || metadata.current_order?.product_name || 'Unknown product';
      const resolvedReason  = collectedReason  || slotsReason || finalMessage || null;

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

    // ── Phase 2 circuit breakers (run BEFORE sendDM, BEFORE metadata persist) ──

    // Trilingual handoff — detect customer language from their latest message
    const hasArabicChars = /[\u0600-\u06FF]/.test(finalMessage || '');
    const hasFrancoMarkers = /\b(3ayez|3ayza|la2|7aga|felosy|2order|ba3at)\b/i.test(finalMessage || '');
    const handoffMsg = hasArabicChars
      ? 'هسيب حد من الفريق يساعدك — لحظة واحدة!'
      : hasFrancoMarkers
        ? 'Haseeb 7ad men el team ysa3dak — lahza wahda!'
        : 'Let me get a teammate to help you with this — one moment!';

    // A. Repetition guard — compare about-to-send reply against last 3 replies
    //    Skip for very short replies (< 8 words) to avoid false positives on pleasantries.
    //    At validation step, require 3 repeats (customer may legitimately retry after a typo).
    const recentReplies = metadata.last_replies || [];
    const normalize = (s) => (s || '').toLowerCase().replace(/[^\w\u0600-\u06FF\s]/g, '').split(/\s+/).filter(Boolean);
    const currentWords = normalize(aiReply || '');
    const repeatThreshold = metadata.step === 'validate' ? 3 : 1;

    if (aiReply && currentWords.length >= 8 && recentReplies.length > 0) {
      const currentSet = new Set(currentWords);
      let repeatCount = 0;
      for (const prev of recentReplies) {
        const prevSet = new Set(normalize(prev));
        if (currentSet.size === 0 && prevSet.size === 0) { repeatCount++; continue; }
        const intersection = [...currentSet].filter(w => prevSet.has(w)).length;
        const union = new Set([...currentSet, ...prevSet]).size;
        if (union > 0 && (intersection / union) > 0.8) repeatCount++;
      }

      if (repeatCount >= repeatThreshold) {
        console.log(`🔁 Repetition guard triggered (${repeatCount} matches, threshold ${repeatThreshold}) — forcing escalation`);
        aiReply = handoffMsg;
        // Force escalation (match existing escalation write shape)
        await supabase
          .from('conversations')
          .update({
            is_escalated: true,
            escalation_type: metadata.flow || 'general',
            escalation_reason: 'AI response loop detected — repeated reply',
            escalated_at: new Date().toISOString(),
            escalated_by: 'ai'
          })
          .eq('id', conversation.id);
      }
    }

    // B. No-progress counter — did this turn advance the flow?
    //    Compares full serialized slots (detects value changes, not just new keys).
    //    Skip terminal steps (escalate, confirm_refund) — no progress is possible by design.
    const terminalSteps = ['escalate', 'confirm_refund'];
    if (metadata.flow && !terminalSteps.includes(metadata.step)) {
      const stepAfter = metadata.step;
      const slotsSnapshotAfter = JSON.stringify(metadata.slots || {});
      const progressed = (stepAfter !== stepBefore) || (slotsSnapshotAfter !== slotsSnapshotBefore);

      if (progressed) {
        metadata.no_progress_count = 0;
      } else {
        metadata.no_progress_count = (metadata.no_progress_count || 0) + 1;
        console.log(`⏳ No-progress count: ${metadata.no_progress_count}`);
      }

      if (metadata.no_progress_count >= 2) {
        console.log(`🚨 No-progress guard triggered (${metadata.no_progress_count} turns) — forcing escalation`);
        aiReply = handoffMsg;
        await supabase
          .from('conversations')
          .update({
            is_escalated: true,
            escalation_type: metadata.flow || 'general',
            escalation_reason: `AI stuck — no progress for ${metadata.no_progress_count} turns`,
            escalated_at: new Date().toISOString(),
            escalated_by: 'ai'
          })
          .eq('id', conversation.id);
        metadata.no_progress_count = 0;
      }
    }

    // Track reply for repetition guard (keep last 3)
    if (aiReply) {
      metadata.last_replies = [...(metadata.last_replies || []), aiReply].slice(-3);
    }

    // ── End circuit breakers ──

    // 11b. Post-AI step transition (Phase 4) — runs on FINAL aiReply after guards.
    //      Skip if circuit breakers replaced the reply with a handoff message (force-escalated).
    if (aiReply && aiReply !== handoffMsg) {
      postAiReplyTransition(aiReply, metadata);
    }

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
          // Single-word keywords match on word boundaries so "size" doesn't fire inside
          // unrelated words ("outfit"); multi-word phrases still use substring matching.
          // Split on non-letter/number chars so trailing punctuation ("size?") still tokenizes.
          const msgWords = msgLower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
          const sizeKeywords = ['size', 'sizing', 'fit', 'fits', 'chart', 'measurement', 'measure',
            'length', 'chest', 'waist', 'hips', 'shoulder', 'مقاس', 'مقاسات', 'قياس', 'قياسات', 'طول',
            'size chart', 'size guide'];
          const isSizeQuestion = sizeKeywords.some(kw =>
            kw.includes(' ') ? msgLower.includes(kw) : msgWords.includes(kw)
          );
          console.log(`📏 isSizeQuestion: ${isSizeQuestion} (message: "${finalMessage}")`);

          if (isSizeQuestion) {
            // A size chart only makes sense for a SPECIFIC product. Identify which product the
            // customer means — named in their current message, or already under discussion. If we
            // can't tie the size question to a product, DON'T send a chart; Luna asks which one.
            const guidesMatching = (haystack) => validGuides.filter(g => {
              const names = Array.isArray(g.product_names) && g.product_names.length > 0
                ? g.product_names
                : (g.product_name ? [g.product_name] : []);
              return names.some(n => n && haystack.includes(n.toLowerCase()));
            });

            // 1) Product named in the customer's current message
            let guidesToSend = guidesMatching(msgLower);

            // 2) Otherwise, a product already discussed in this conversation
            if (guidesToSend.length === 0) {
              const discussedNames = (metadata.discussed_products || [])
                .map(p => (p.name || '').toLowerCase())
                .filter(Boolean)
                .join(' | ');
              if (discussedNames) {
                guidesToSend = guidesMatching(discussedNames);
              }
            }

            if (guidesToSend.length > 0) {
              for (const guide of guidesToSend) {
                try {
                  console.log(`📏 Sending size chart image: ${guide.image_url}`);
                  await sendImageDM(senderId, guide.image_url, access_token);
                  console.log(`📏 Sent size chart for "${guide.product_name}" to ${senderId}`);
                } catch (imgErr) {
                  console.error(`❌ Failed to send size chart image: ${imgErr.message}`);
                }
              }
            } else {
              console.log(`📏 Size intent but no specific product identified — skipping auto-send (Luna will ask which product)`);
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
      .insert([{
        conversation_id: conversation.id,
        sender: 'ai',
        content: aiReply,
      }]);

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
