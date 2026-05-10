const supabaseAdmin = require('./supabase-admin');

const COSTS = {
  'gpt-4o-mini': { input: 0.000150, output: 0.000600 },  // per 1K tokens
  'gpt-4o':      { input: 0.002500, output: 0.010000 },  // per 1K tokens
  'gpt-4.1':     { input: 0.002000, output: 0.008000 },  // per 1K tokens
  'gpt-4.1-mini':{ input: 0.000400, output: 0.001600 },  // per 1K tokens
  'whisper-1':   { perSecond: 0.000167 }                 // $0.006/min
};

/**
 * Log OpenAI usage to luna_usage_logs. Fire-and-forget — never throws.
 *
 * @param {object} params
 * @param {string} params.brandId
 * @param {string} params.conversationId
 * @param {'text'|'image'|'voice'|'story'} params.messageType
 * @param {'gpt-4o-mini'|'gpt-4o'|'whisper-1'} params.model
 * @param {number} [params.promptTokens]        - from response.usage.prompt_tokens
 * @param {number} [params.completionTokens]    - from response.usage.completion_tokens
 * @param {number} [params.totalTokens]         - from response.usage.total_tokens
 * @param {number} [params.audioDurationSeconds] - for whisper-1 only
 */
function logUsage({
  brandId,
  conversationId,
  messageType,
  model,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  audioDurationSeconds = 0
}) {
  // Calculate cost
  let costUsd = 0;
  const rates = COSTS[model];
  if (rates) {
    if (model === 'whisper-1') {
      costUsd = audioDurationSeconds * rates.perSecond;
    } else {
      costUsd = (promptTokens / 1000) * rates.input
              + (completionTokens / 1000) * rates.output;
    }
  }

  // Fire-and-forget
  supabaseAdmin
    .from('luna_usage_logs')
    .insert({
      brand_id: brandId,
      conversation_id: conversationId,
      message_type: messageType,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cost_usd: costUsd
    })
    .then(({ error }) => {
      if (error) console.error('⚠️  usage-logger insert failed:', error.message);
    })
    .catch(err => console.error('⚠️  usage-logger error:', err.message));
}

module.exports = { logUsage };
