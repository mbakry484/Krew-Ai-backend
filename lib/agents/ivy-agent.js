const { client, defaultModel } = require('../ai-provider');
const supabase = require('../supabase');

// =============================================================================
// IVY EXPENSE AGENT — Telegram slot-filling loop
// =============================================================================
// A brand team member messages Ivy over Telegram to log an operating expense.
// Ivy captures AMOUNT, CATEGORY, and which CAPITAL POOL to deduct from, asking
// only for what's missing, then writes via the atomic ivy_log_expense RPC.
//
// Runs a tool-use loop on the shared OpenAI-compatible client (lib/ai-provider).
//
// SECURITY:
//   * brandId and role are injected into every tool executor by the loop. They
//     are resolved server-side from the sender's chat_id (see routes/telegram.js)
//     and NEVER come from the model or the message.
//   * media_buyer role NEVER sees a capital balance — list_capitals strips it and
//     log_expense withholds new_balance, so the model cannot leak a figure it
//     was never given.
//
// STATE: multi-turn filling is durable across Railway restarts. The working
// message transcript is persisted in ivy_pending_expenses.slots (keyed by
// chat_id) and replayed each turn; it is cleared once an expense is logged.
// =============================================================================

const EXPENSE_CATEGORIES = [
  'inventory_materials', 'marketing_ads', 'shipping_fulfillment', 'salaries',
  'packaging', 'software', 'rent_utilities', 'fees_commissions', 'other',
];

const MAX_TOOL_HOPS = 4;

function systemPrompt(role) {
  const today = new Date().toISOString().slice(0, 10);
  const roleLine = role === 'media_buyer'
    ? `The person you are talking to is a MEDIA BUYER. You ONLY handle expense logging for them. If they ask for analytics or capital balances, tell them that's owner-only. Never state a pool balance.`
    : `The person you are talking to is the brand OWNER. After logging you may state the resulting pool balance.`;

  return `You are Ivy, the financial assistant for a brand on the Krew platform. You talk to a brand
team member over Telegram to log operating expenses. Be concise and direct.
Your job: capture an expense. Required fields are AMOUNT, CATEGORY, and which CAPITAL POOL to
deduct from. NOTE and DATE are optional (date defaults to today, ${today}).

Parse amounts from natural language including "k"/"K" = thousand (e.g. "10k" = 10000),
Arabic, Franco-Arabic, and English. "الف"/"ألف" = thousand.
CATEGORY must be one of: inventory_materials, marketing_ads, shipping_fulfillment, salaries,
packaging, software, rent_utilities, fees_commissions, other. Infer it from the note
("bought fabric" -> inventory_materials, "ads"/"boosting" -> marketing_ads). If genuinely
ambiguous, ask.
Use the list_capitals tool to see this brand's pools. If there is more than one pool and the
user didn't say which, ask which pool. If there's only one pool, use it automatically without
asking.
Ask ONLY for fields that are missing. Never ask for something already provided.
Once AMOUNT, CATEGORY and CAPITAL POOL are known, call the log_expense tool. Do not ask for
confirmation unless the amount is unusually large (> 100000) — then confirm once before logging.
Reply in the user's language (Arabic / Franco / English) matching how they wrote.
${roleLine}`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_capitals',
      description: "List this brand's capital pools so you can resolve which pool the user means or present choices.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_expense',
      description: 'Log an operating expense and deduct it from a capital pool. Only call when amount, category and capital_id are all known.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Expense amount in EGP (already parsed to a number, e.g. 10000 for "10k").' },
          category: { type: 'string', enum: EXPENSE_CATEGORIES },
          capital_id: { type: 'string', description: 'UUID of the capital pool to deduct from (from list_capitals).' },
          note: { type: 'string', description: "Optional short note; defaults to the user's phrasing." },
          spent_at: { type: 'string', description: 'Optional ISO 8601 date/time. Defaults to now.' },
        },
        required: ['amount', 'category', 'capital_id'],
        additionalProperties: false,
      },
    },
  },
];

// ── Tool executors (brandId/role injected by the loop, never from the model) ──

async function listCapitals(brandId, role) {
  const { data, error } = await supabase
    .from('ivy_capitals')
    .select('id, name, current_balance')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: true });
  if (error) return { error: 'db_error' };
  const rows = data || [];
  // Media buyers must never see a balance figure.
  if (role === 'media_buyer') return { capitals: rows.map(({ id, name }) => ({ id, name })) };
  return { capitals: rows };
}

async function logExpense(brandId, role, args) {
  const { amount, category, capital_id, note, spent_at } = args || {};
  const { data, error } = await supabase.rpc('ivy_log_expense', {
    p_brand_id: brandId,
    p_amount: amount,
    p_category: category,
    p_capital_id: capital_id,
    p_note: note || '',
    p_source: 'text',
    p_spent_at: spent_at || new Date().toISOString(),
  });
  if (error) {
    console.error('[ivy-agent] log_expense rpc error:', error.message);
    return { ok: false, error: 'db_error' };
  }
  if (!data || !data.ok) return data || { ok: false, error: 'unknown' };
  // Media buyers never receive a balance figure.
  if (role === 'media_buyer') return { ok: true, expense_id: data.expense_id };
  return data;
}

// ── Pending transcript persistence ───────────────────────────────────────────

async function loadTranscript(chatId) {
  const { data } = await supabase
    .from('ivy_pending_expenses')
    .select('slots')
    .eq('chat_id', chatId)
    .maybeSingle();
  const messages = data && data.slots && Array.isArray(data.slots.messages) ? data.slots.messages : [];
  return messages;
}

async function saveTranscript(chatId, brandId, messages) {
  await supabase
    .from('ivy_pending_expenses')
    .upsert({
      chat_id: chatId,
      brand_id: brandId,
      slots: { messages },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'chat_id' });
}

async function clearPending(chatId) {
  await supabase.from('ivy_pending_expenses').delete().eq('chat_id', chatId);
}

/**
 * Run one inbound Telegram message through Ivy's expense loop.
 * @param {{ chatId: string, brandId: string, role: 'owner'|'media_buyer', userText: string }} ctx
 * @returns {Promise<string>} the reply text to send back over Telegram
 */
async function runIvyAgent({ chatId, brandId, role, userText }) {
  const prior = await loadTranscript(chatId);
  const conversation = [...prior, { role: 'user', content: userText }];

  let completed = false;

  try {
    for (let hop = 0; hop <= MAX_TOOL_HOPS; hop++) {
      const completion = await client.chat.completions.create({
        model: defaultModel,
        temperature: 0,
        messages: [{ role: 'system', content: systemPrompt(role) }, ...conversation],
        tools: TOOLS,
        tool_choice: 'auto',
      });

      const msg = completion.choices[0].message;
      conversation.push(msg);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        // Assistant produced text: either a follow-up question or the closing line.
        if (completed) {
          await clearPending(chatId);
        } else {
          await saveTranscript(chatId, brandId, conversation);
        }
        return (msg.content || '').trim() || '👍';
      }

      // Execute each requested tool and feed results back.
      for (const call of toolCalls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }

        let result;
        if (call.function.name === 'list_capitals') {
          result = await listCapitals(brandId, role);
        } else if (call.function.name === 'log_expense') {
          result = await logExpense(brandId, role, args);
          if (result && result.ok) completed = true;
        } else {
          result = { error: 'unknown_tool' };
        }

        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Hop cap hit without a natural-language close. Keep pending so the user can
    // retry, and nudge them briefly.
    await saveTranscript(chatId, brandId, conversation);
    return 'Sorry — I got a bit tangled there. Could you say that again?';
  } catch (err) {
    console.error('[ivy-agent] loop error:', err.message);
    // Keep whatever partial state we had so a retry can continue.
    return "Sorry, something went wrong on my side. Please try again in a moment.";
  }
}

module.exports = { runIvyAgent };
