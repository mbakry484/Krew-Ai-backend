const cron = require('node-cron');
const supabase = require('../lib/supabase');
const OpenAI = require('openai');
const { logUsage } = require('../lib/usage-logger');
const { INTERACTION_GAP_MS } = require('../lib/interaction-tracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY?.trim() });

const ANALYSIS_MODEL = 'gpt-4o-mini';
const BATCH_SIZE = 20; // Process up to 20 interactions per run

const ANALYSIS_PROMPT = `You are analyzing a customer support conversation between a customer and an AI assistant (Luna) for a brand.

Analyze the conversation and return a JSON object with these fields:
- "sentiment": one of "angry", "frustrated", "neutral", "satisfied", "happy"
- "sentiment_score": a float from -1.0 (most negative) to 1.0 (most positive)
- "issue_category": a short label describing the main issue (e.g. "sizing issue", "late delivery", "color mismatch", "product quality", "wrong item received", "payment issue", "product inquiry", "order status"). Use lowercase. If no issue, use "general inquiry".
- "issue_summary": one sentence summarizing what the customer wanted or complained about.
- "resolution_status": one of "resolved" (customer's issue was addressed), "unresolved" (customer left without resolution), "escalated" (was handed off to a human agent)

Return ONLY valid JSON, no markdown fences, no extra text.`;

/**
 * Analyze a single interaction's messages with gpt-4o-mini.
 * Returns the parsed analysis or null on failure.
 */
async function analyzeInteraction(interaction) {
  // Fetch messages for this interaction's time window
  const { data: messages, error } = await supabase
    .from('messages')
    .select('sender, content, created_at')
    .eq('conversation_id', interaction.conversation_id)
    .gte('created_at', interaction.started_at)
    .lte('created_at', interaction.ended_at)
    .order('created_at', { ascending: true });

  if (error || !messages || messages.length === 0) {
    console.error(`  interaction-analysis: no messages for ${interaction.id}`, error?.message);
    return null;
  }

  // Build conversation transcript
  const transcript = messages
    .filter(m => m.content)
    .map(m => {
      const role = m.sender === 'customer' ? 'Customer' : m.sender === 'ai' ? 'Luna (AI)' : 'Human Agent';
      return `${role}: ${m.content}`;
    })
    .join('\n');

  if (!transcript.trim()) return null;

  try {
    const response = await openai.chat.completions.create({
      model: ANALYSIS_MODEL,
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: transcript },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);

    // Log usage (fire-and-forget)
    logUsage({
      brandId: interaction.brand_id,
      conversationId: interaction.conversation_id,
      messageType: 'text',
      model: ANALYSIS_MODEL,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    });

    return parsed;
  } catch (err) {
    console.error(`  interaction-analysis: OpenAI error for ${interaction.id}:`, err.message);
    return null;
  }
}

/**
 * Calculate average response time (customer msg -> AI reply) in milliseconds
 * for messages within this interaction's time window.
 */
async function calcResponseTime(interaction) {
  const { data: messages } = await supabase
    .from('messages')
    .select('sender, created_at')
    .eq('conversation_id', interaction.conversation_id)
    .gte('created_at', interaction.started_at)
    .lte('created_at', interaction.ended_at)
    .order('created_at', { ascending: true });

  if (!messages || messages.length < 2) return null;

  const gaps = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].sender === 'customer' && messages[i + 1].sender === 'ai') {
      const diff = new Date(messages[i + 1].created_at).getTime() - new Date(messages[i].created_at).getTime();
      gaps.push(diff);
    }
  }

  if (gaps.length === 0) return null;
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
}

/**
 * Main analysis loop: find unanalyzed interactions that ended 30+ min ago,
 * analyze them, and update the rows.
 */
async function runAnalysisBatch() {
  const cutoff = new Date(Date.now() - INTERACTION_GAP_MS).toISOString();

  // Find interactions that are "closed" (ended_at older than gap threshold) and not yet analyzed
  const { data: pending, error } = await supabase
    .from('interactions')
    .select('*')
    .is('analyzed_at', null)
    .lt('ended_at', cutoff)
    .order('ended_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error('interaction-analysis: fetch error:', error.message);
    return;
  }

  if (!pending || pending.length === 0) return;

  console.log(`interaction-analysis: analyzing ${pending.length} interaction(s)...`);

  let success = 0;
  let failed = 0;

  for (const interaction of pending) {
    const [analysis, avgResponseMs] = await Promise.all([
      analyzeInteraction(interaction),
      calcResponseTime(interaction),
    ]);

    if (!analysis) {
      failed++;
      // Mark as analyzed anyway to prevent infinite retries on bad data
      await supabase
        .from('interactions')
        .update({ analyzed_at: new Date().toISOString() })
        .eq('id', interaction.id);
      continue;
    }

    const { error: updateErr } = await supabase
      .from('interactions')
      .update({
        sentiment: analysis.sentiment,
        sentiment_score: analysis.sentiment_score,
        issue_category: analysis.issue_category,
        issue_summary: analysis.issue_summary,
        resolution_status: interaction.was_escalated ? 'escalated' : analysis.resolution_status,
        response_time_avg_ms: avgResponseMs,
        analyzed_at: new Date().toISOString(),
      })
      .eq('id', interaction.id);

    if (updateErr) {
      console.error(`  interaction-analysis: update failed for ${interaction.id}:`, updateErr.message);
      failed++;
    } else {
      success++;
    }
  }

  console.log(`interaction-analysis: batch complete — ${success} analyzed, ${failed} failed`);
}

/**
 * Start the interaction analysis cron job.
 * Runs every 5 minutes.
 */
function startInteractionAnalysisCron() {
  console.log('interaction-analysis: cron scheduled (every 5 minutes)');

  cron.schedule('*/5 * * * *', async () => {
    try {
      await runAnalysisBatch();
    } catch (err) {
      console.error('interaction-analysis: cron error:', err.message);
    }
  });
}

module.exports = { startInteractionAnalysisCron, runAnalysisBatch };
