/**
 * Intelligent Prompt Manager
 * Dynamically selects and assembles relevant prompts based on conversation context
 * This optimizes token usage by only including what's needed
 */

const coreIdentity = require('./core-identity');
const orderTaking = require('./order-taking');
const exchangesRefunds = require('./exchanges-refunds');
const policyQuestions = require('./policy-questions');
const deliveryIssues = require('./delivery-issues');
const productCatalog = require('./product-catalog');
const escalation = require('./escalation');
const positiveMessages = require('./positive-messages');

/**
 * Analyze conversation context to determine which prompts are needed
 * @param {string} customerMessage - Latest customer message
 * @param {array} conversationHistory - Previous messages
 * @param {object} metadata - Conversation metadata
 * @returns {object} Context analysis
 */
function analyzeContext(customerMessage, conversationHistory = [], metadata = null) {
  const msg = customerMessage.toLowerCase();
  const context = {
    isOrderIntent: false,
    isExchangeIntent: false,
    isRefundIntent: false,
    isPolicyQuestion: false,
    isDeliveryComplaint: false,
    isPositiveMessage: false,
    needsProductCatalog: false,
    hasImage: false,
    isEscalationNeeded: false
  };

  // Order intent detection
  const orderKeywords = ['order', 'buy', 'purchase', 'get', 'take', 'want', '3ayez', '3ayza', 'عايز', 'عايزة', 'بدي', 'خد', 'اشتري'];
  context.isOrderIntent = orderKeywords.some(keyword => msg.includes(keyword)) ||
                          !!(metadata && metadata.current_order) ||
                          !!(metadata && metadata.discussed_products && metadata.discussed_products.length > 0);

  // Exchange intent detection — check current message AND recent conversation history
  const exchangeKeywords = ['exchange', 'change', 'swap', 'wrong size', 'different size', 'تبديل', 'تغيير', 'مقاس'];
  // Also check conversation history (last 10 messages) since exchange/refund is a multi-step flow
  const recentHistory = (conversationHistory || []).slice(-10).map(m => (m.content || '').toLowerCase()).join(' ');
  context.isExchangeIntent = exchangeKeywords.some(keyword => msg.includes(keyword)) ||
                              exchangeKeywords.some(keyword => recentHistory.includes(keyword));

  // Refund intent detection — check current message AND recent conversation history
  const refundKeywords = ['refund', 'money back', 'return', 'استرجاع', 'فلوس', 'رجوع'];
  context.isRefundIntent = refundKeywords.some(keyword => msg.includes(keyword)) ||
                            refundKeywords.some(keyword => recentHistory.includes(keyword));

  // Policy question detection
  const policyKeywords = ['policy', 'policies', 'how long', 'shipping', 'delivery time', 'cancel', 'سياسة', 'توصيل', 'شحن', 'الغاء'];
  context.isPolicyQuestion = policyKeywords.some(keyword => msg.includes(keyword));

  // Delivery complaint detection
  const deliveryKeywords = ['late', 'delayed', 'hasn\'t arrived', 'not arrived', 'where is', 'متأخر', 'تأخر', 'وصل', 'فين'];
  context.isDeliveryComplaint = deliveryKeywords.some(keyword => msg.includes(keyword));

  // Positive message detection
  const positiveKeywords = ['love', 'amazing', 'great', 'best', 'perfect', 'thank you', 'thanks', 'appreciate', 'حلو', 'جميل', 'رائع', 'شكرا'];
  const negativeKeywords = ['not', 'don\'t', 'didn\'t', 'but', 'however', 'مش', 'ما'];
  const hasPositiveWords = positiveKeywords.some(keyword => msg.includes(keyword));
  const hasNegativeWords = negativeKeywords.some(keyword => msg.includes(keyword));
  context.isPositiveMessage = hasPositiveWords && !hasNegativeWords;

  // Product catalog needed?
  const productKeywords = [
    'what', 'show', 'available', 'have', 'stock', 'products', 'sell', 'selling',
    'catalog', 'collection', 'item', 'price', 'cost', 'how much', 'بكم', 'بقد ايه',
    'ايه', 'عندكو', 'متوفر', 'معاكم', 'بتبيعو', 'اسعار', 'منتج', 'منتجات'
  ];
  // Size-related keywords — trigger size guide injection
  const sizeKeywords = [
    'size', 'sizing', 'fit', 'fits', 'chart', 'measurement', 'measure', 'length',
    'chest', 'waist', 'hips', 'shoulder', 'small', 'medium', 'large', 'xl', 'xxl',
    'مقاس', 'مقاسات', 'قياس', 'قياسات', 'طول', 'عرض', 'صدر', 'خصر',
    'size chart', 'size guide'
  ];
  // Use word-boundary matching for size keywords to avoid false positives
  // (e.g. "Mohamed" matching "m", "small" inside "smallest")
  const msgWords = msg.split(/\s+/);
  context.isSizeQuery = sizeKeywords.some(keyword => {
    if (keyword.includes(' ')) return msg.includes(keyword); // multi-word: substring match
    return msgWords.includes(keyword); // single-word: exact word match
  });
  context.needsProductCatalog = productKeywords.some(keyword => msg.includes(keyword)) ||
                                 !!context.isOrderIntent ||
                                 context.isSizeQuery;

  // Escalation triggers
  const escalationKeywords = ['manager', 'supervisor', 'speak to', 'talk to', 'job', 'hire', 'partnership', 'مدير', 'مسؤول', 'وظيفة'];
  context.isEscalationNeeded = escalationKeywords.some(keyword => msg.includes(keyword));

  return context;
}

/**
 * Build optimized system prompt based on context
 * @param {object} params - All parameters needed for prompt building
 * @returns {string} Assembled system prompt
 */
function buildOptimizedPrompt({
  businessName = 'our business',
  businessType = null,
  brandDescription = null,
  customerMessage = '',
  conversationHistory = [],
  metadata = null,
  inStockProducts = [],
  outOfStockProducts = [],
  knowledgeBaseRows = [],
  hasImage = false,
  storyContext = '',
  situationsEnabled = false,
  situations = [],
  sizeGuidesEnabled = false,
  sizeGuides = [],
  voiceProfile = null
}) {
  // Analyze what prompts we need
  const context = analyzeContext(customerMessage, conversationHistory, metadata);

  // Always start with core identity
  let prompt = coreIdentity.getPrompt(businessName, businessType, brandDescription);

  // Active flow always injects the exchange/refund module (step-aware or legacy).
  // Keyword detection only gates entry when no flow is active.
  const activeFlow = metadata && metadata.flow;
  const activeStep = metadata && metadata.step;
  const isExchangeRefundFlow = activeFlow && (activeFlow === 'exchange' || activeFlow === 'refund');

  if (context.isExchangeIntent || context.isRefundIntent || isExchangeRefundFlow) {
    if (isExchangeRefundFlow && activeStep) {
      prompt += '\n\n' + exchangesRefunds.getStepPrompt(activeStep, metadata, inStockProducts, outOfStockProducts, activeFlow);
    } else {
      prompt += '\n\n' + exchangesRefunds.getPrompt(inStockProducts, outOfStockProducts);
    }
  }

  // Add order-taking prompt — but NEVER during an active exchange/refund flow.
  // The order-taking prompt competes with exchange/refund instructions and confuses the AI
  // (e.g., customer answering "which item to refund?" gets treated as a new order).
  if (!isExchangeRefundFlow && (context.isOrderIntent || (metadata && metadata.current_order))) {
    prompt += '\n\n' + orderTaking.getPrompt(metadata);
  }

  if (context.isPolicyQuestion) {
    prompt += '\n\n' + policyQuestions.getPrompt();
  }

  if (context.isDeliveryComplaint) {
    prompt += '\n\n' + deliveryIssues.getPrompt();
  }

  if (context.isPositiveMessage) {
    prompt += '\n\n' + positiveMessages.getPrompt();
  }

  // Add product catalog if needed (always include for images so Luna has full catalog context)
  if (context.needsProductCatalog || context.isOrderIntent || hasImage) {
    prompt += '\n\n' + productCatalog.getPrompt(inStockProducts, outOfStockProducts);

    if (hasImage) {
      prompt += '\n\n' + productCatalog.getImageHandlingPrompt();
    }
  }

  // Always include escalation rules
  prompt += '\n\n' + escalation.getPrompt();

  // Add knowledge base LAST so it overrides any conflicting system prompt instructions
  if (knowledgeBaseRows && knowledgeBaseRows.length > 0) {
    const allFaqs = [];
    knowledgeBaseRows.forEach((kb) => {
      if (kb.faqs && Array.isArray(kb.faqs)) {
        allFaqs.push(...kb.faqs);
      }
    });

    if (allFaqs.length > 0) {
      prompt += '\n\n';
      prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 KNOWLEDGE BASE — HIGHEST PRIORITY\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      prompt += `CRITICAL: The answers below come directly from the brand's knowledge base. If any answer here conflicts with the general instructions above, ALWAYS follow the knowledge base answer. These are the brand's own policies and facts.\n\n`;

      allFaqs.forEach((faq) => {
        if (faq.question && faq.answer) {
          prompt += `Q: ${faq.question}\nA: ${faq.answer}\n\n`;
        }
      });
    }
  }

  // Inject active brand situations — instructions Luna must follow during these periods
  if (situationsEnabled && situations && situations.length > 0) {
    prompt += '\n\n';
    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ CURRENT BRAND SITUATIONS — MANDATORY\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    prompt += `CRITICAL: The following situations are currently active for this brand. You MUST proactively communicate these to customers whenever relevant — especially when they ask about orders, delivery, or anything that could be affected. Never hide or downplay these situations.\n\n`;

    situations.forEach((s, i) => {
      if (s.text) {
        prompt += `• ${s.text}\n`;
      }
    });

    prompt += `\nWhenever a customer's question touches on any of the above, acknowledge the situation clearly and set expectations accordingly BEFORE proceeding.\n`;
  }

  // Inject size guides — Luna must ALWAYS send the chart image, never describe in words
  if (sizeGuidesEnabled && sizeGuides && sizeGuides.length > 0) {
    prompt += '\n\n';
    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📏 SIZE GUIDES — MANDATORY BEHAVIOR\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    prompt += `CRITICAL SIZE GUIDE RULES:\n`;
    prompt += `1. Whenever a customer asks about sizing, measurements, fit, length, chest, waist, hips, or ANY size-related question — you MUST immediately send the relevant size chart image WITHOUT any lengthy text explanation.\n`;
    prompt += `2. Send the image FIRST. A brief one-line message is acceptable (e.g. "Here's the size chart 📏"), nothing more.\n`;
    prompt += `3. NEVER describe sizes in words if a chart image is available. Always use the image.\n`;
    prompt += `4. If the customer specifies a product, send that product's size guide. If unsure which product, send all relevant ones.\n\n`;
    prompt += `Available size guides:\n`;

    sizeGuides.forEach((guide) => {
      // Support both new multi-product format and legacy single product
      const names = Array.isArray(guide.product_names) && guide.product_names.length > 0
        ? guide.product_names
        : (guide.product_name ? [guide.product_name] : []);
      if (names.length === 0) return;

      const namesLabel = names.join(', ');
      prompt += `\n— Product(s): ${namesLabel}\n`;
      // Only include real HTTP URLs — never base64/data URIs (they break the API and bloat the prompt)
      const hasRealImage = guide.image_url && guide.image_url.startsWith('http');
      if (hasRealImage) {
        prompt += `  → A size chart image exists and will be sent automatically as a photo attachment by the system.\n`;
        prompt += `  → Your ONLY job is to reply with one short sentence like: "Here's the size chart! 📏"\n`;
        prompt += `  → Do NOT describe measurements. Do NOT mention URLs. Do NOT add any explanation.\n`;
      } else if (guide.content) {
        prompt += `  Size info: ${guide.content}\n`;
      } else {
        prompt += `  → A size chart image will be sent automatically. Reply with only: "Here's the size chart! 📏"\n`;
      }
    });
  }

  // Inject voice profile if the brand has one active
  if (voiceProfile) {
    prompt += '\n\n';
    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎙️ TONE & VOICE — BRAND PERSONALITY\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    prompt += `CRITICAL: The following voice profile was learned from this brand's real customer service history. You MUST match this tone, style, and personality in every reply.\n\n`;

    if (voiceProfile.summary) {
      prompt += `Overview: ${voiceProfile.summary}\n\n`;
    }

    if (voiceProfile.tone && Array.isArray(voiceProfile.tone)) {
      prompt += `Tone keywords: ${voiceProfile.tone.join(', ')}\n`;
    }

    if (voiceProfile.formality) {
      prompt += `Formality level: ${voiceProfile.formality}\n`;
    }

    if (voiceProfile.message_length) {
      prompt += `Message length: ${voiceProfile.message_length}\n`;
    }

    if (voiceProfile.emoji_usage) {
      prompt += `Emoji usage: ${voiceProfile.emoji_usage}\n`;
    }

    if (voiceProfile.greeting_style) {
      prompt += `\nGreeting style: "${voiceProfile.greeting_style.example}"`;
      if (voiceProfile.greeting_style.notes) prompt += ` — ${voiceProfile.greeting_style.notes}`;
      prompt += '\n';
    }

    if (voiceProfile.closing_style) {
      prompt += `Closing style: "${voiceProfile.closing_style.example}"`;
      if (voiceProfile.closing_style.notes) prompt += ` — ${voiceProfile.closing_style.notes}`;
      prompt += '\n';
    }

    if (voiceProfile.complaint_handling) {
      prompt += `\nComplaint handling approach: ${voiceProfile.complaint_handling.approach}\n`;
      if (voiceProfile.complaint_handling.example) {
        prompt += `Example: "${voiceProfile.complaint_handling.example}"\n`;
      }
    }

    if (voiceProfile.signature_phrases && Array.isArray(voiceProfile.signature_phrases) && voiceProfile.signature_phrases.length > 0) {
      prompt += `\nSignature phrases (use these naturally):\n`;
      voiceProfile.signature_phrases.forEach((phrase) => {
        prompt += `  • "${phrase}"\n`;
      });
    }

    if (voiceProfile.language_mix) {
      const mix = voiceProfile.language_mix;
      const parts = [];
      if (mix.english) parts.push(`English ${mix.english}%`);
      if (mix.arabic) parts.push(`Arabic ${mix.arabic}%`);
      if (mix.franco_arabic) parts.push(`Franco-Arabic ${mix.franco_arabic}%`);
      if (parts.length > 0) {
        prompt += `\nLanguage mix: ${parts.join(', ')}\n`;
      }
    }
  }

  // Add story/shared-post context if available
  if (storyContext) {
    prompt += '\n\n';
    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📖 STORY / POST CONTEXT\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (storyContext === '__no_image__') {
      prompt += `The customer replied to one of your stories or posts, but the image is no longer accessible (expired or private).

HOW TO HANDLE:
- Greet them warmly and ask what caught their eye or what they'd like to know.
- Do NOT pretend you know what the story showed.
- Example: "Hey! What can I help you with? 😊" or ask what they were interested in.`;
    } else {
      prompt += `The customer is replying to one of your stories or posts. Here is what it showed:\n${storyContext}\n\n`;
      prompt += `HOW TO HANDLE — read the customer's message and pick the right approach:

CASE 1 — Customer's message is clearly about the story/post (e.g. "how much is that?", "is that available?", "I love this"):
→ Use the story context to identify the product shown and answer directly.
→ If the story shows a specific product from the catalog, reference it by name, give price and availability.
→ If the story is lifestyle/mood content with no specific product, acknowledge what they liked and guide them to the catalog.

CASE 2 — Customer's message is unrelated to the story (e.g. "where's my order?", "do you have hoodies?"):
→ Ignore the story context entirely. Answer their actual question as a normal customer service message.
→ Do NOT force a connection between their question and the story.

CASE 3 — No customer message (they just tapped reply with no text):
→ Greet them and ask what caught their eye or how you can help.
→ Reference what the story showed if it was a product: "Glad you liked the [product]! Want to know more about it?"

⛔ NEVER make up product names or details not in the catalog.
⛔ NEVER assume the customer is asking about the story if their message is clearly about something else.`;
    }
  }

  return prompt.trim();
}

/**
 * Get a lightweight prompt for simple queries (optimization)
 * @param {string} businessName - Business name
 * @returns {string} Minimal system prompt
 */
function buildMinimalPrompt(businessName) {
  return coreIdentity.getPrompt(businessName) + '\n\n' + escalation.getPrompt();
}

module.exports = {
  analyzeContext,
  buildOptimizedPrompt,
  buildMinimalPrompt
};
