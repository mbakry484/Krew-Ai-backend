const OpenAI = require('openai');
const supabase = require('./supabase');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generate an AI reply for a customer message using OpenAI
 * @param {string} customerMessage - The incoming message from the customer
 * @param {array} knowledgeBaseRows - Array of knowledge base entries { question, answer }
 * @param {array} products - Array of product objects { name, description, price, in_stock }
 * @param {string} brandId - The brand ID to fetch business name
 * @returns {Promise<string>} The AI-generated reply
 */
async function generateReply(customerMessage, knowledgeBaseRows, products, brandId) {
  try {
    console.log(`   📊 AI Context:`, {
      knowledgeBaseEntries: knowledgeBaseRows?.length || 0,
      products: products?.length || 0,
      brandId: brandId
    });

    // Fetch business name from users table
    console.log(`   🏢 Fetching business name for brand: ${brandId}`);
    let businessName = 'our business';
    if (brandId) {
      const { data: user } = await supabase
        .from('users')
        .select('business_name')
        .eq('id', brandId)
        .maybeSingle();

      if (user?.business_name) {
        businessName = user.business_name;
        console.log(`   ✅ Business name: ${businessName}`);
      } else {
        console.log(`   ⚠️  Business name not found, using default`);
      }
    }

    // Build system prompt with brand context
    console.log(`   🔨 Building system prompt...`);
    const systemPrompt = buildSystemPrompt(businessName, knowledgeBaseRows, products);
    console.log(`   ✅ System prompt built (${systemPrompt.length} chars)`);

    console.log(`   🚀 Calling OpenAI API (gpt-4o-mini)...`);
    const startTime = Date.now();

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
      max_tokens: 500,
    });

    const duration = Date.now() - startTime;
    console.log(`   ✅ OpenAI responded in ${duration}ms`);
    console.log(`   📝 Response length: ${completion.choices[0].message.content.length} chars`);

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('❌ Error generating OpenAI reply:', error.message);
    console.error('   Error details:', {
      name: error.name,
      status: error.status,
      code: error.code
    });
    throw error;
  }
}

/**
 * Build system prompt with brand knowledge and product catalog
 * @param {string} businessName - Business name
 * @param {array} knowledgeBaseRows - Knowledge base Q&A entries
 * @param {array} products - Product catalog
 * @returns {string} System prompt
 */
function buildSystemPrompt(businessName, knowledgeBaseRows, products) {
  let prompt = `You are Luna, an AI customer support agent for ${businessName}.
You help customers with questions about products, orders, delivery and returns.
Always reply in the same language the customer uses.
Keep replies short, friendly and helpful.\n\n`;

  // Add Knowledge Base
  if (knowledgeBaseRows && knowledgeBaseRows.length > 0) {
    prompt += `Knowledge Base:\n`;
    knowledgeBaseRows.forEach((kb) => {
      // Handle different schema formats
      const question = kb.question || kb.title || kb.q || 'N/A';
      const answer = kb.answer || kb.content || kb.a || kb.response || 'N/A';

      if (question !== 'N/A' && answer !== 'N/A') {
        prompt += `Q: ${question}\nA: ${answer}\n\n`;
      }
    });
  }

  // Add product catalog
  if (products && products.length > 0) {
    prompt += `Products:\n`;
    products.forEach((product) => {
      const availability = product.in_stock ? 'in stock' : 'out of stock';
      prompt += `- ${product.name}`;
      if (product.description) {
        prompt += `: ${product.description}`;
      }
      prompt += `\n  Price: ${product.price || 'N/A'}`;
      prompt += `\n  Availability: ${availability}\n`;
    });
    prompt += '\n';
  }

  prompt += `If you don't know the answer, say you'll connect them with the team.
Never make up information not in the knowledge base or products.`;

  return prompt;
}

module.exports = { generateReply };
