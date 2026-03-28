const OpenAI = require('openai');
const supabase = require('./supabase');
const { buildOptimizedPrompt, analyzeContext } = require('./prompts/prompt-manager');

// Validate OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ FATAL: OPENAI_API_KEY environment variable is not set!');
  console.error('   Please add OPENAI_API_KEY to your environment variables.');
  throw new Error('OPENAI_API_KEY is required');
}

// Check if API key has valid format
const apiKey = process.env.OPENAI_API_KEY.trim();
if (apiKey.length < 20 || apiKey.includes('\n') || apiKey.includes('\r')) {
  console.error('❌ FATAL: OPENAI_API_KEY appears to be malformed!');
  console.error('   Key length:', apiKey.length);
  console.error('   Key preview:', apiKey.substring(0, 10) + '...');
  console.error('   Contains newlines:', apiKey.includes('\n'));
  throw new Error('OPENAI_API_KEY is malformed');
}

console.log('✅ OpenAI API Key loaded successfully');
console.log('   Key preview:', apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 4));

const openai = new OpenAI({
  apiKey: apiKey,
});

/**
 * Download an image from a URL and convert to base64
 * @param {string} url - The image URL to download
 * @returns {Promise<{base64: string, contentType: string}>} Base64 data and content type
 */
async function downloadImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return { base64, contentType };
}

/**
 * Generate an AI reply for a customer message using OpenAI
 * @param {string} customerMessage - The incoming message from the customer
 * @param {array} knowledgeBaseRows - Array of knowledge base entries { question, answer }
 * @param {array} inStockProducts - Array of in-stock product objects
 * @param {array} outOfStockProducts - Array of out-of-stock product objects
 * @param {string} brandId - The brand ID to fetch business name
 * @param {array} conversationHistory - Previous messages [{ role, content }]
 * @param {object} metadata - Conversation metadata with order state
 * @param {string} businessName - Business name for personalization
 * @param {string|null} imageUrl - Optional image URL for vision queries
 * @returns {Promise<string>} The AI-generated reply
 */
async function generateReply(
  customerMessage,
  knowledgeBaseRows,
  inStockProducts,
  outOfStockProducts,
  brandId,
  conversationHistory = [],
  metadata = null,
  businessName = 'our business',
  imageUrl = null,
  storyContext = ''
) {
  try {
    // Use new optimized prompt system
    const systemPrompt = buildOptimizedPrompt({
      businessName,
      customerMessage,
      conversationHistory,
      metadata,
      inStockProducts,
      outOfStockProducts,
      knowledgeBaseRows,
      hasImage: !!imageUrl,
      storyContext
    });

    // Log prompt context for debugging
    const context = analyzeContext(customerMessage, conversationHistory, metadata);
    console.log('🤖 AI Context:', JSON.stringify(context, null, 2));

    // Switch to GPT-4o when image is present
    const model = imageUrl ? 'gpt-4o' : 'gpt-4.1';

    // Build user content with image if present
    let userContent;
    if (imageUrl) {
      try {
        const { base64, contentType } = await downloadImageAsBase64(imageUrl);
        userContent = [
          {
            type: 'text',
            text: customerMessage || 'What is this product? Is it available in our store?'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${contentType};base64,${base64}`,
              detail: 'low'
            }
          }
        ];
      } catch (err) {
        console.error('Failed to download image:', err.message);
        // Fall back to text only if image download fails
        userContent = customerMessage || 'The customer sent an image but it could not be loaded.';
      }
    } else {
      userContent = customerMessage;
    }

    // Build messages array: system + conversation history + new message
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: userContent },
    ];

    const completion = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: 700,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('❌ OpenAI error:', error.message);
    throw error;
  }
}

/**
 * Build system prompt with brand knowledge, product catalog, and order-taking flow
 * @param {string} businessName - Business name
 * @param {array} knowledgeBaseRows - Knowledge base Q&A entries
 * @param {array} inStockProducts - In-stock products
 * @param {array} outOfStockProducts - Out-of-stock products
 * @param {object} metadata - Conversation metadata with order state
 * @returns {string} System prompt
 */
function buildSystemPrompt(businessName, knowledgeBaseRows, inStockProducts, outOfStockProducts, metadata = null) {
  let prompt = `
You are Luna, a smart and friendly AI customer support and sales agent for ${businessName}.
Your job is to help customers with product questions, taking orders, delivery info, and returns.
`;

  // Step 2: Add current order state to system prompt
  if (metadata) {
    prompt += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛒 CURRENT ORDER STATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    // Products discussed
    if (metadata.discussed_products && metadata.discussed_products.length > 0) {
      prompt += `Products discussed in this conversation:\n`;
      metadata.discussed_products.forEach(product => {
        prompt += `  ${product.index}. ${product.name} — ${product.price} EGP\n`;
      });
      prompt += `\n`;
    } else {
      prompt += `- No products discussed yet\n\n`;
    }

    // Current order
    if (metadata.current_order) {
      prompt += `Currently ordering: ${metadata.current_order.product_name} (${metadata.current_order.price} EGP)\n\n`;
    } else {
      prompt += `Currently ordering: None\n\n`;
    }

    // Collected information
    prompt += `Information collected so far:\n`;
    prompt += `  • Name: ${metadata.collected_info?.name || 'Not yet collected'}\n`;
    prompt += `  • Phone: ${metadata.collected_info?.phone || 'Not yet collected'}\n`;
    prompt += `  • Address: ${metadata.collected_info?.address || 'Not yet collected'}\n\n`;

    // What we're waiting for
    if (metadata.awaiting) {
      const awaitingMap = {
        'name': 'customer name',
        'phone': 'phone number',
        'address': 'delivery address',
        'confirmation': 'order confirmation'
      };
      prompt += `Currently waiting for: ${awaitingMap[metadata.awaiting] || metadata.awaiting}\n`;
    } else {
      prompt += `Currently waiting for: Nothing specific\n`;
    }
  }

  prompt += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 LANGUAGE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ALWAYS reply in the same language the customer is using.
- Supported languages: English, Arabic (formal), and Franco Arabic (Arabic written in Latin letters/numbers like "3" for ع).
- If the customer switches language mid-conversation, switch with them naturally.
- Never reply in a language the customer didn't use first.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛍️ ORDER-TAKING FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a customer wants to place an order (e.g. says "I want to order", "I'll take", "buy", "order", "3ayez", "بدي", "خد", etc.):

STEP 1 — Confirm the product:
  - Identify the product from the conversation or ask which product they want.
  - Use the numbered list from "Products discussed" so customers can say "the first one" or "number 2".
  - Confirm product name, variant (size/color if applicable), quantity, and price.
  - Only offer products that are listed and in stock.

STEP 2 — Collect order details (ask ONE at a time, don't overwhelm):
  - Full name
  - Phone number
  - Delivery address

  Important: Only ask for information that hasn't been collected yet (check CURRENT ORDER STATE above).

STEP 3 — Show order summary and ask for confirmation:
  Once you have all 4 pieces (product + name + phone + address), present a clean summary like this:

  ✅ Order Summary:
  • Product: [product name]
  • Price: [price] EGP
  • Name: [customer name]
  • Phone: [phone number]
  • Address: [address]

  Then ask: "Do you want to confirm this order?" or the equivalent in their language.

STEP 4 — After customer confirms:
  - Reply with EXACTLY the word: ORDER_READY
  - This triggers the order creation system.
  - Do NOT add anything else when you say ORDER_READY.

ALTERNATIVE — If the customer prefers to order through the website:
  - Guide them to the website and offer to answer any questions along the way.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 PRODUCT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Only recommend or sell products listed below in the Product Catalog.
- If a product is out of stock, let the customer know politely and suggest alternatives if available.
- Never make up products, prices, or availability.
- Reference products by their number when they've been discussed (e.g., "Would you like to order the first one?").

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📸 IMAGE HANDLING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If the customer sends an image:
- Identify what product or type of product is shown
- Check if a similar product exists in the Product Catalog below
- If found → confirm availability and price
- If not found → apologize and suggest the closest available alternative
- Never make up products that aren't in the catalog

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💬 TONE & BEHAVIOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Be warm, friendly, and concise. No long paragraphs.
- Use emojis sparingly to keep it human and approachable.
- Never be robotic or repeat the same phrases.
- If you don't know something, say: "Let me connect you with our team for this one!" — never guess or fabricate.
- Only use information from the Knowledge Base and Product Catalog below.

`;

  // ── Knowledge Base ──────────────────────────────────────────
  if (knowledgeBaseRows && knowledgeBaseRows.length > 0) {
    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 KNOWLEDGE BASE\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    // Flatten FAQs from all knowledge base rows
    const allFaqs = [];
    knowledgeBaseRows.forEach((kb) => {
      // Each kb row has a 'faqs' array of {question, answer} objects
      if (kb.faqs && Array.isArray(kb.faqs)) {
        allFaqs.push(...kb.faqs);
      }
    });

    console.log(`📚 Loaded ${allFaqs.length} FAQs from knowledge base`);

    // Add each FAQ to the prompt
    allFaqs.forEach((faq) => {
      if (faq.question && faq.answer) {
        prompt += `Q: ${faq.question}\nA: ${faq.answer}\n\n`;
      }
    });
  } else {
    console.log(`⚠️  No knowledge base entries found`);
  }

  // ── Product Catalog ─────────────────────────────────────────
  prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛒 PRODUCT CATALOG\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  // Build in-stock product list
  const inStockList = (inStockProducts || []).slice(0, 30).map((p, i) =>
    `${i + 1}. ${p.name} - ${p.price} EGP ✅ In Stock`
  ).join('\n');

  // Build out-of-stock product list
  const outOfStockList = (outOfStockProducts || []).slice(0, 30).map((p, i) =>
    `${i + 1}. ${p.name} - ${p.price} EGP ❌ Out of Stock`
  ).join('\n');

  // Add available products section
  prompt += `\nAVAILABLE PRODUCTS (can be ordered):\n`;
  if (inStockList) {
    prompt += `${inStockList}\n`;
  } else {
    prompt += `No products currently in stock\n`;
  }

  // Add out-of-stock products section
  prompt += `\nOUT OF STOCK PRODUCTS (cannot be ordered right now):\n`;
  if (outOfStockList) {
    prompt += `${outOfStockList}\n`;
  } else {
    prompt += `None\n`;
  }

  // Add availability rules
  prompt += `\nRULES FOR PRODUCT AVAILABILITY:\n`;
  prompt += `- Only offer to take orders for IN STOCK products\n`;
  prompt += `- If asked about an out of stock product → acknowledge it exists, state it's currently unavailable, suggest similar in-stock alternatives if any\n`;
  prompt += `- Never pretend an out of stock product is available\n`;
  prompt += `- If customer asks "what do you have?" → only list in-stock products\n`;
  prompt += `- If customer asks about a specific product that's OOS → tell them honestly and offer alternatives\n`;
  prompt += `\n`;

  return prompt.trim();
}

/**
 * Check if AI response contains escalation keywords
 * @param {string} aiResponse - The AI's response
 * @returns {object} Escalation info { shouldEscalate: boolean, type: string|null, reason: string|null }
 */
function checkEscalation(aiResponse) {
  const response = aiResponse.toUpperCase();

  if (response.includes('ESCALATE_EXCHANGE')) {
    return {
      shouldEscalate: true,
      type: 'exchange',
      reason: 'Customer requested exchange - requires team review'
    };
  }

  if (response.includes('ESCALATE_REFUND')) {
    return {
      shouldEscalate: true,
      type: 'refund',
      reason: 'Customer requested refund - requires team review'
    };
  }

  if (response.includes('ESCALATE_DELIVERY')) {
    return {
      shouldEscalate: true,
      type: 'delivery',
      reason: 'Delivery issue reported - requires team attention'
    };
  }

  if (response.includes('ESCALATE_GENERAL')) {
    return {
      shouldEscalate: true,
      type: 'general',
      reason: 'Conversation escalated to team'
    };
  }

  return {
    shouldEscalate: false,
    type: null,
    reason: null
  };
}

module.exports = {
  generateReply,
  buildSystemPrompt, // Keep for backward compatibility
  checkEscalation
};