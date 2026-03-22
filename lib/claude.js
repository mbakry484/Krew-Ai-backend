const OpenAI = require('openai');
const supabase = require('./supabase');

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
 * Generate an AI reply for a customer message using OpenAI
 * @param {string} customerMessage - The incoming message from the customer
 * @param {array} knowledgeBaseRows - Array of knowledge base entries { question, answer }
 * @param {array} products - Array of product objects { name, description, price, in_stock }
 * @param {string} brandId - The brand ID to fetch business name
 * @param {array} conversationHistory - Previous messages [{ role, content }]
 * @param {object} metadata - Conversation metadata with order state
 * @param {string} businessName - Business name for personalization
 * @returns {Promise<string>} The AI-generated reply
 */
async function generateReply(
  customerMessage,
  knowledgeBaseRows,
  products,
  brandId,
  conversationHistory = [],
  metadata = null,
  businessName = 'our business'
) {
  try {
    // Build system prompt with brand context and order state
    const systemPrompt = buildSystemPrompt(businessName, knowledgeBaseRows, products, metadata);

    // Build messages array: system + conversation history + new message
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: customerMessage },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
 * @param {array} products - Product catalog
 * @param {object} metadata - Conversation metadata with order state
 * @returns {string} System prompt
 */
function buildSystemPrompt(businessName, knowledgeBaseRows, products, metadata = null) {
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

  Then ask: "Can you confirm this order?" or the equivalent in their language.

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
    knowledgeBaseRows.forEach((kb) => {
      const question = kb.question || kb.title || kb.q || null;
      const answer = kb.answer || kb.content || kb.a || kb.response || null;
      if (question && answer) {
        prompt += `Q: ${question}\nA: ${answer}\n\n`;
      }
    });
  }

  // ── Product Catalog ─────────────────────────────────────────
  if (products && products.length > 0) {
    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛒 PRODUCT CATALOG\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    products.forEach((product) => {
      const availability = product.in_stock ? '✅ In Stock' : '❌ Out of Stock';
      prompt += `• ${product.name}`;
      if (product.description) prompt += `\n  ${product.description}`;
      prompt += `\n  Price: ${product.price || 'N/A'}`;
      prompt += `\n  Availability: ${availability}\n\n`;
    });
  }

  return prompt.trim();
}

module.exports = { generateReply };