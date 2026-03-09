const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generate an AI reply for a customer message using OpenAI
 * @param {string} customerMessage - The incoming message from the customer
 * @param {object} knowledgeBase - Brand knowledge base data from Supabase
 * @param {array} products - Array of product objects from Supabase
 * @returns {Promise<string>} The AI-generated reply
 */
async function generateReply(customerMessage, knowledgeBase, products) {
  try {
    // Build system prompt with brand context
    const systemPrompt = buildSystemPrompt(knowledgeBase, products);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: customerMessage,
        },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error generating OpenAI reply:', error);
    throw error;
  }
}

/**
 * Build system prompt with brand knowledge and product catalog
 * @param {object} knowledgeBase - Brand knowledge base
 * @param {array} products - Product catalog
 * @returns {string} System prompt
 */
function buildSystemPrompt(knowledgeBase, products) {
  let prompt = `You are an AI customer service assistant for ${knowledgeBase?.brand_name || 'our brand'}. Your role is to help customers with their questions about products, orders, and general inquiries.\n\n`;

  // Add brand voice and guidelines
  if (knowledgeBase?.tone) {
    prompt += `Brand Voice: ${knowledgeBase.tone}\n\n`;
  }

  if (knowledgeBase?.guidelines) {
    prompt += `Guidelines:\n${knowledgeBase.guidelines}\n\n`;
  }

  // Add FAQs
  if (knowledgeBase?.faqs && knowledgeBase.faqs.length > 0) {
    prompt += `Frequently Asked Questions:\n`;
    knowledgeBase.faqs.forEach((faq, index) => {
      prompt += `${index + 1}. Q: ${faq.question}\n   A: ${faq.answer}\n`;
    });
    prompt += '\n';
  }

  // Add product catalog
  if (products && products.length > 0) {
    prompt += `Product Catalog:\n`;
    products.forEach((product) => {
      prompt += `- ${product.name}: ${product.description || 'No description'}\n`;
      if (product.price) {
        prompt += `  Price: $${product.price}\n`;
      }
      if (product.availability) {
        prompt += `  Availability: ${product.availability}\n`;
      }
    });
    prompt += '\n';
  }

  prompt += `Instructions:
- Be helpful, friendly, and professional
- Keep responses concise and relevant
- If you don't know something, say so and offer to connect them with a human representative
- Focus on providing accurate information based on the knowledge base and product catalog above
- Do not make up information about products or policies`;

  return prompt;
}

module.exports = { generateReply };
