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
                          !!(metadata && metadata.current_order);

  // Exchange intent detection
  const exchangeKeywords = ['exchange', 'change', 'swap', 'wrong size', 'different size', 'تبديل', 'تغيير', 'مقاس'];
  context.isExchangeIntent = exchangeKeywords.some(keyword => msg.includes(keyword));

  // Refund intent detection
  const refundKeywords = ['refund', 'money back', 'return', 'استرجاع', 'فلوس', 'رجوع'];
  context.isRefundIntent = refundKeywords.some(keyword => msg.includes(keyword));

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
  context.needsProductCatalog = productKeywords.some(keyword => msg.includes(keyword)) ||
                                 !!context.isOrderIntent;

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
  storyContext = ''
}) {
  // Analyze what prompts we need
  const context = analyzeContext(customerMessage, conversationHistory, metadata);

  // Always start with core identity
  let prompt = coreIdentity.getPrompt(businessName, businessType, brandDescription);

  // Add relevant scenario-specific prompts
  if (context.isOrderIntent || (metadata && metadata.current_order)) {
    prompt += '\n\n' + orderTaking.getPrompt(metadata);
  }

  if (context.isExchangeIntent || context.isRefundIntent) {
    prompt += '\n\n' + exchangesRefunds.getPrompt();
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

  // Add story context if available
  if (storyContext) {
    prompt += '\n\n';
    prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📖 STORY CONTEXT\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    prompt += `The customer is replying to your story that shows: ${storyContext}\n`;
    prompt += `Use this context to understand what they're asking about.\n`;
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
