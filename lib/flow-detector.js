/**
 * Flow Detector & Step Transition Engine (Phase 4)
 *
 * Code-owned state machine that drives metadata.flow, metadata.step, metadata.slots.
 * Runs once per incoming message, BEFORE prompt building.
 *
 * Step graph:
 *
 *   EXCHANGE FLOW                          REFUND FLOW
 *   ────────────                           ───────────
 *   validate                               validate
 *     ↓ (VALID result)                       ↓ (VALID result)
 *   collect_item_reason                    collect_item_reason
 *     ↓ (item + reason filled)              ↓ (item + reason filled)
 *   pick_replacement                       suggest_exchange
 *     ↓ (replacement filled)                 ↓ (suggestion sent, latch flipped)
 *   escalate (terminal)                    awaiting_exchange_decision
 *                                            ↓ decline → confirmRefund (terminal, escalates inline)
 *                                            ↓ accept  → switch to exchange flow, pick_replacement
 *
 * Mid-flow re-classification:
 *   At any step, if the current message contains clear re-classification keywords,
 *   the flow switches. Filled slots and latch state are preserved.
 */

const { client: openai } = require('./ai-provider');

// ── Keyword tables ───────────────────────────────────────────────────────────

const EXCHANGE_ENTRY_KEYWORDS = [
  'exchange', 'swap', 'change', 'replace', 'different size', 'wrong size', "doesn't fit", 'doesnt fit',
  'تبديل', 'تغيير', 'استبدال', 'مقاس تاني', 'غير المقاس', 'بدل',
  'tabdeel', '3ayez a8ayar', 'size tany'
];

const REFUND_ENTRY_KEYWORDS = [
  'refund', 'money back', 'return my money', 'give me my money', 'i want my money',
  'استرجاع فلوس', 'ارجاع فلوس', 'عايز فلوسي', 'استرداد', 'رجعولي فلوسي',
  '3ayez felosy', 'erga3ly felosy'
];

// Ambiguous — could be exchange or refund, needs classifier
const AMBIGUOUS_RETURN_KEYWORDS = [
  'return', 'send it back', 'send back', 'ارجاع', 'رجوع', 'ابعته تاني'
];

// Re-classification: these override flow mid-conversation
const EXCHANGE_RECLASSIFY_KEYWORDS = [
  'actually exchange', 'actually swap', 'want to exchange', 'want to swap', 'i want exchange',
  'change it instead', 'swap instead', 'exchange instead',
  'عايز ابدل', 'تبديل بدل', 'ابدل بدل'
];

const REFUND_RECLASSIFY_KEYWORDS = [
  'actually refund', 'want refund', 'want to refund', 'i want my money', 'i want a refund',
  'want my money back', 'money back instead', 'refund instead', 'just refund',
  'no i want refund', 'no refund', 'no i want to refund',
  'عايز فلوسي', 'لا عايز فلوسي', 'فلوسي بس', 'ارجعولي فلوسي',
  '3ayez felosy', 'la2 3ayez felosy', 'refund bas'
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function msgContains(msg, keywords) {
  const lower = (msg || '').toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

/**
 * Classify ambiguous "return" intent via gpt-4o-mini.
 * Only called when entry keywords are ambiguous — not on every turn.
 */
async function classifyAmbiguousIntent(customerMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 30,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a classifier. The customer wants to return a product. Determine if they want:
- "exchange" (swap for a different product/size/color)
- "refund" (get their money back)
- "unclear" (cannot determine)

Reply with ONLY one word: exchange, refund, or unclear.`
        },
        { role: 'user', content: customerMessage }
      ]
    });
    const result = (completion.choices[0].message.content || '').trim().toLowerCase();
    if (result === 'exchange' || result === 'refund') return result;
    return 'unclear';
  } catch (err) {
    console.error('❌ Ambiguous intent classifier failed:', err.message);
    return 'unclear';
  }
}

/**
 * Classify whether the customer accepted or declined the exchange suggestion.
 * This is the ONE fuzzy, high-stakes transition that justifies a classifier call.
 */
async function classifyExchangeDecision(customerMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 30,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a classifier. The customer was asked if they'd like to exchange their product instead of getting a refund. Based on their reply, determine:
- "accept_exchange" (they agree to exchange/swap)
- "decline_exchange" (they insist on refund/money back, say no, or reject the suggestion)
- "unclear" (cannot determine, they asked a question or said something unrelated)

Reply with ONLY one of: accept_exchange, decline_exchange, unclear.`
        },
        { role: 'user', content: customerMessage }
      ]
    });
    const result = (completion.choices[0].message.content || '').trim().toLowerCase();
    if (result === 'accept_exchange' || result === 'decline_exchange') return result;
    // Unrecognized output → fail toward progress (decline → escalate, never stall)
    console.log(`⚠️ Exchange decision classifier returned unrecognized: "${result}" — defaulting to decline_exchange`);
    return 'decline_exchange';
  } catch (err) {
    console.error('❌ Exchange decision classifier failed:', err.message, '— defaulting to decline_exchange');
    return 'decline_exchange';
  }
}

// ── Flow entry detection ─────────────────────────────────────────────────────

/**
 * Detect if the current message starts an exchange/refund flow.
 * Only fires when metadata.flow is null (no active flow).
 * Uses current message only (not history window) to avoid sticky-intent.
 *
 * @returns {string|null} 'exchange', 'refund', or null (no flow entry)
 */
async function detectFlowEntry(customerMessage) {
  const isExchange = msgContains(customerMessage, EXCHANGE_ENTRY_KEYWORDS);
  const isRefund = msgContains(customerMessage, REFUND_ENTRY_KEYWORDS);

  // Clear signal — one but not both
  if (isExchange && !isRefund) return 'exchange';
  if (isRefund && !isExchange) return 'refund';

  // Both signals (rare) — refund takes priority since it's more specific
  if (isExchange && isRefund) return 'refund';

  // Check for ambiguous "return" keywords
  if (msgContains(customerMessage, AMBIGUOUS_RETURN_KEYWORDS)) {
    return await classifyAmbiguousIntent(customerMessage);
  }

  return null;
}

// ── Mid-flow re-classification ───────────────────────────────────────────────

/**
 * Check if the customer is switching flows mid-conversation.
 * Preserves filled slots and the exchange_suggested latch.
 *
 * @returns {string|null} New flow type, or null if no switch
 */
function detectReclassification(customerMessage, currentFlow) {
  if (currentFlow === 'exchange' && msgContains(customerMessage, REFUND_RECLASSIFY_KEYWORDS)) {
    return 'refund';
  }
  if (currentFlow === 'refund' && msgContains(customerMessage, EXCHANGE_RECLASSIFY_KEYWORDS)) {
    return 'exchange';
  }
  return null;
}

/**
 * Recompute the step after a flow switch, based on which slots are already filled.
 */
function recomputeStepAfterSwitch(newFlow, slots) {
  // If order is already validated, skip back to validate
  const hasOrder = slots.order_id && slots.customer_name;
  const hasItemReason = slots.item && slots.reason;

  if (!hasOrder) return 'validate';
  if (!hasItemReason) return 'collect_item_reason';

  if (newFlow === 'exchange') return 'pick_replacement';
  if (newFlow === 'refund') return 'suggest_exchange';

  return 'validate';
}

// ── Main step transition engine ──────────────────────────────────────────────

/**
 * Run the step detector on an incoming message.
 * Mutates metadata.flow, metadata.step, metadata.slots, metadata.exchange_suggested.
 * Called once per incoming message, BEFORE prompt building.
 *
 * @param {string} customerMessage - The current customer message
 * @param {object} metadata - Conversation metadata (mutated in place)
 * @param {string|null} aiReply - The AI reply from this turn (null on first call, set on post-AI call)
 * @param {string|null} validationResult - The SYSTEM_VALIDATION_RESULT string (if this turn had validation)
 * @returns {object} metadata (same reference, mutated)
 */
async function runStepDetector(customerMessage, metadata) {
  const msg = (customerMessage || '').toLowerCase();

  // ── No active flow → check for entry ──
  if (!metadata.flow) {
    const flow = await detectFlowEntry(customerMessage);
    if (flow && flow !== 'unclear') {
      metadata.flow = flow;
      metadata.step = 'validate';
      metadata.slots = metadata.slots || {};
      console.log(`🔄 Flow entered: ${flow}, step: validate`);
    }
    return metadata;
  }

  // ── Active flow → check for mid-flow re-classification ──
  const newFlow = detectReclassification(customerMessage, metadata.flow);
  if (newFlow) {
    const oldFlow = metadata.flow;
    metadata.flow = newFlow;
    metadata.step = recomputeStepAfterSwitch(newFlow, metadata.slots || {});

    // When switching FROM exchange TO refund, the customer explicitly rejected
    // the exchange concept — flip the latch so we don't suggest exchange again.
    if (oldFlow === 'exchange' && newFlow === 'refund') {
      metadata.exchange_suggested = true;
      // Skip suggest_exchange entirely → go straight to confirm_refund (terminal)
      if (metadata.step === 'suggest_exchange') {
        metadata.step = 'confirm_refund';
      }
    }

    console.log(`🔄 Flow re-classified: ${oldFlow} → ${newFlow}, step: ${metadata.step}`);
    return metadata;
  }

  // ── Step-specific transitions ──
  const step = metadata.step;
  const slots = metadata.slots || {};

  switch (step) {
    case 'validate': {
      // Try to extract order_id and customer_name from the message.
      // The AI will emit VALIDATE_ORDER JSON, but we can also pre-fill slots
      // from the customer's message to track progress.
      const orderIdMatch = msg.match(/(?:#|order\s*(?:number|no\.?|id)?:?\s*)(\d{3,})/i)
                        || msg.match(/\b(\d{4,})\b/); // bare 4+ digit number
      const nameFromMsg = extractNameCandidate(customerMessage);

      if (orderIdMatch && !slots.order_id) {
        slots.order_id = orderIdMatch[1];
        console.log(`📝 Slot filled: order_id = ${slots.order_id}`);
      }
      if (nameFromMsg && !slots.customer_name) {
        slots.customer_name = nameFromMsg;
        console.log(`📝 Slot filled: customer_name = ${slots.customer_name}`);
      }
      metadata.slots = slots;
      // Step advancement from validate → collect_item_reason happens in
      // postValidationTransition() after SYSTEM_VALIDATION_RESULT comes back.
      break;
    }

    case 'collect_item_reason': {
      // The customer should be telling us which product and why.
      // We can't reliably extract item/reason from free text with keywords alone —
      // the AI does this better. But we can detect if the customer gave *something*.
      // Heuristic: if the message is > 5 words and not a question, assume they gave info.
      const words = msg.split(/\s+/).filter(Boolean);
      const isQuestion = msg.includes('?') || msg.startsWith('what') || msg.startsWith('which');
      if (words.length > 5 && !isQuestion) {
        // Mark as potentially filled — the AI will parse the actual values
        if (!slots.item) {
          slots.item = '__pending_ai_parse__';
          console.log(`📝 Slot filled (pending): item`);
        }
        if (!slots.reason) {
          slots.reason = '__pending_ai_parse__';
          console.log(`📝 Slot filled (pending): reason`);
        }
        metadata.slots = slots;

        // Advance step based on flow
        if (metadata.flow === 'exchange') {
          metadata.step = 'pick_replacement';
          console.log(`📋 Step advanced: collect_item_reason → pick_replacement`);
        } else if (metadata.flow === 'refund') {
          metadata.step = 'suggest_exchange';
          console.log(`📋 Step advanced: collect_item_reason → suggest_exchange`);
        }
      }
      break;
    }

    case 'pick_replacement': {
      // Exchange flow: customer tells us what they want instead.
      // Again, hard to parse reliably — but if the message mentions a product or has
      // substantial content, mark as filled.
      const words = msg.split(/\s+/).filter(Boolean);
      if (words.length >= 2 && !slots.replacement) {
        slots.replacement = '__pending_ai_parse__';
        metadata.slots = slots;
        metadata.step = 'escalate';
        console.log(`📋 Step advanced: pick_replacement → escalate`);
      }
      break;
    }

    case 'suggest_exchange': {
      // Refund flow: Luna should suggest exchange on this turn.
      // The latch flip happens when Luna sends the suggestion (see postAiReplyTransition).
      // No customer-side transition here — we're waiting for Luna to send first.
      break;
    }

    case 'awaiting_exchange_decision': {
      // Refund flow: customer responds to exchange suggestion.
      // This is the fuzzy transition — use the classifier.
      const decision = await classifyExchangeDecision(customerMessage);
      console.log(`🤖 Exchange decision classified: ${decision}`);

      if (decision === 'accept_exchange') {
        // Switch to exchange flow, go to pick_replacement
        metadata.flow = 'exchange';
        metadata.step = 'pick_replacement';
        console.log(`📋 Customer accepted exchange → switching to exchange flow, pick_replacement`);
      } else if (decision === 'decline_exchange') {
        // confirmRefund is terminal — it contains escalation instructions inline.
        // No separate 'escalate' step needed for the decline path.
        metadata.step = 'confirm_refund';
        console.log(`📋 Customer declined exchange → confirm_refund (terminal)`);
      }
      // If 'unclear', stay at awaiting_exchange_decision — AI will re-ask.
      break;
    }

    case 'confirm_refund': {
      // Terminal — confirmRefund() contains escalation instructions.
      // No further transitions. The escalation keyword in the AI reply
      // will trigger checkEscalation() → is_escalated = true.
      break;
    }

    case 'escalate': {
      // Terminal for exchange flow.
      // No further transitions.
      break;
    }
  }

  return metadata;
}

// ── Post-AI reply transitions ────────────────────────────────────────────────

/**
 * Run after the AI generates a reply, to handle transitions that depend on
 * what Luna said (not what the customer said).
 *
 * Key transition: when Luna sends the exchange suggestion in the refund flow,
 * flip the latch and advance to awaiting_exchange_decision.
 */
function postAiReplyTransition(aiReply, metadata) {
  if (!metadata.flow || !metadata.step) return metadata;

  // Refund flow, suggest_exchange step: Luna just sent the suggestion.
  // Flip the latch and advance to awaiting_exchange_decision.
  if (metadata.flow === 'refund' && metadata.step === 'suggest_exchange') {
    metadata.exchange_suggested = true;
    metadata.step = 'awaiting_exchange_decision';
    console.log(`📋 Post-AI: suggest_exchange → awaiting_exchange_decision (latch flipped)`);
  }

  return metadata;
}

/**
 * Run after VALIDATE_ORDER processing to advance the step based on the result.
 * Called from instagram.js after the validation round-trip.
 */
function postValidationTransition(validationResult, metadata) {
  if (!metadata.flow || metadata.step !== 'validate') return metadata;

  if (validationResult && validationResult.includes('SYSTEM_VALIDATION_RESULT: VALID')) {
    metadata.step = 'collect_item_reason';
    // Extract order details from the validation result and fill slots
    const orderMatch = validationResult.match(/Order #(\S+)/);
    const nameMatch = validationResult.match(/confirmed for "([^"]+)"/);
    if (orderMatch) metadata.slots.order_id = orderMatch[1];
    if (nameMatch) metadata.slots.customer_name = nameMatch[1];
    console.log(`📋 Post-validation: validate → collect_item_reason`);
  } else if (validationResult && validationResult.includes('SYSTEM_VALIDATION_RESULT: ALREADY_EXISTS')) {
    // Customer already has an active exchange/refund — exit the flow.
    // The AI reply (from the re-invocation) will inform them it's already being handled.
    // No point retrying or escalating — clear the flow so Luna returns to normal mode.
    metadata.flow = null;
    metadata.step = null;
    console.log(`📋 Post-validation: ALREADY_EXISTS → flow cleared`);
  }
  // INVALID → stay at validate, customer retries.

  return metadata;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Basic name extraction from a message.
 * Looks for patterns like "name is X", "under X", "ana X" (Franco Arabic).
 * Returns null if no clear name found — we don't want false positives here.
 */
function extractNameCandidate(msg) {
  const patterns = [
    /(?:my name is|name is|i'm|i am|under|el esm|اسمي|اسم)\s+([A-Za-z\u0600-\u06FF]{2,}(?:\s+[A-Za-z\u0600-\u06FF]{2,})*)/i,
    /(?:ana|أنا)\s+([A-Za-z\u0600-\u06FF]{2,}(?:\s+[A-Za-z\u0600-\u06FF]{2,})*)/i,
  ];
  for (const pattern of patterns) {
    const match = msg.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

module.exports = {
  runStepDetector,
  postAiReplyTransition,
  postValidationTransition,
  detectFlowEntry,
  classifyExchangeDecision,
  classifyAmbiguousIntent,
};
