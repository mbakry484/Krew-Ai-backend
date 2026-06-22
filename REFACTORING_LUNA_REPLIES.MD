# Task: Fix Luna's conversation loops in exchange/refund (and order) flows

## Background — read this first

Luna (the AI agent in this repo) gets stuck in infinite loops during
exchange/refund and order-taking flows. She repeats herself instead of
progressing or escalating. A real production example: a customer said "I want
to refund" five times, gave a clear reason ("hole in it"), and declined an
exchange three times — Luna re-offered the exchange every turn and never
escalated.

Root cause (already diagnosed, do not re-litigate):
1. `conversations.metadata` only tracks `discussed_products` and
   `current_order`. There is NO flow/step state, so Luna re-derives her
   decision from scratch every turn with no memory of what already happened.
2. Intent detection in `prompt-manager.js` (`analyzeContext`) checks the last
   ~10 messages, so once "refund"/"exchange" appears, the FULL
   `exchanges-refunds.js` module reloads every turn — re-presenting the
   "suggest exchange once" instruction as if fresh.
3. `exchanges-refunds.js` is a ~200-line monolith encoding a 4-step state
   machine in prose. It even says "after ONE suggestion, stop" — and the model
   still loops, proving prose cannot enforce state transitions.
4. Escalation only fires if the model voluntarily emits `ESCALATE_REFUND` /
   `ESCALATE_EXCHANGE`. When stuck looping, it never emits them.

Guiding principle for the whole task:
**The LLM handles natural language. Deterministic code owns state, transitions,
and exits.** Anything that must reliably happen "once" or "after N turns" or
"then stop" belongs in code, not in the prompt.

## Files involved (verify paths before editing)

- `instagram.js` — main webhook/per-message handler. Key regions (line numbers
  approximate, CONFIRM by reading):
  - ~587-590: `defaultMetadata` definition
  - ~644-648: metadata read/merge
  - ~800-971: AI reply generation
  - ~1196-1197 & ~1610-1614: metadata writes
  - ~1401-1514: escalation keyword handling + record creation
  - ~1568: `sendDM()` call
  - ~1589-1608: customer-side escalation safety net
- `prompt-manager.js` — `analyzeContext()` (~23-98) and
  `buildOptimizedPrompt()` (~106-333)
- `prompts/exchanges-refunds.js` (or wherever it lives) — the monolith to split
- `claude.js` — `checkEscalation()` (~327-367)

## STOP — investigate before writing code

Before making ANY changes, read and report back to me:
1. The full body of `buildOptimizedPrompt()` — specifically HOW modules are
   concatenated into the final system prompt.
2. The full `analyzeContext()` function.
3. The exact current shape of `defaultMetadata` and every place metadata is
   read or written.
4. `checkEscalation()` and the escalation record-creation block.
5. Confirm the real file path of `exchanges-refunds.js`.

Summarize what you found and your implementation plan. Do NOT proceed to code
until I confirm. If anything contradicts the background above, flag it.

## Implementation — do these in ORDER, one commit each, stop after each for review

### Phase 1 — Extend metadata (backward-compatible, zero risk)

Add new fields to `defaultMetadata`, keeping existing ones:

```js
const defaultMetadata = {
  discussed_products: [],
  current_order: null,
  // --- new flow-state fields ---
  flow: null,                  // 'exchange' | 'refund' | 'order' | null
  step: null,                  // step name within the flow
  slots: {},                   // { order_id, customer_name, item, reason, replacement }
  exchange_suggested: false,   // latch: once true, never suggest exchange again
  no_progress_count: 0,        // increments on turns that fill no slot / don't advance
  last_replies: []             // last 3 outgoing replies, for repetition detection
};
```

The existing read/merge logic (`{ ...defaultMetadata, ...conversation.metadata }`)
must continue to work so old conversations don't break. Verify this.

### Phase 2 — Deterministic circuit breakers (ship this FIRST after metadata; it stops the bleeding even before the state machine exists)

In `instagram.js`, in post-processing BEFORE the `sendDM()` call (~1568):

**A. Repetition guard.** Compare the about-to-send reply against
`metadata.last_replies`. Use normalized word-overlap (lowercase, strip
punctuation, Jaccard/shared-word ratio). If overlap > 0.8 with any recent
reply:
- Do NOT send the repeated reply.
- Force escalation: set `is_escalated = true`, `escalation_type = 'general'`,
  `escalated_by = 'ai'` (match the existing escalation write shape — read it
  first), and send a single templated handoff line instead, e.g.
  "Let me get a teammate to help you with this — one moment!" (respect Luna's
  trilingual rule; match the customer's language if feasible, else English).

After every successfully sent reply, push it into `metadata.last_replies` and
keep only the last 3.

**B. No-progress counter.** Track whether this turn advanced anything (a slot
got filled OR `step` changed). If not, increment `metadata.no_progress_count`;
if it did, reset to 0. When `no_progress_count >= 2`, force escalation the same
way as above.

Both write into the metadata already persisted at ~1610-1614 — no new storage.

Make these guards FLOW-AGNOSTIC: they must work regardless of whether the state
machine in Phase 3 exists yet. This is the safety net.

### Phase 3 — Split `exchanges-refunds.js` into per-step injections

Refactor the monolith from a single `getPrompt()` into per-step getters.
PRESERVE all existing classification rules, trilingual trigger words, tone
guidance, and the escalation summary format — only CHANGE how much is injected
at once.

Target structure (adapt names to the real flow):

```js
module.exports = {
  // shared helpers (product list builders) stay as-is
  refundSteps: {
    validate: (...) => `...Step 1 validation instructions only...`,
    collectItemReason: (...) => `...Step 2 only...`,
    suggestExchange: (...) => `...the ONE exchange suggestion...`,
    confirmRefund: (...) => `...proceed-to-refund instructions, NO suggestion text...`,
    escalate: (...) => `...Step 4 summary + ESCALATE_REFUND...`,
  },
  exchangeSteps: {
    validate: (...) => `...`,
    collectItemReason: (...) => `...`,
    pickReplacement: (...) => `...stock-check instructions...`,
    escalate: (...) => `...summary + ESCALATE_EXCHANGE...`,
  }
};
```

In `buildOptimizedPrompt()`, replace the single full-module injection with a
switch on `metadata.flow` + `metadata.step` that injects ONLY the current
step. Critical latch:

```js
case 'exchange_suggested':
  if (!metadata.exchange_suggested) inject(refundSteps.suggestExchange(...));
  else inject(refundSteps.confirmRefund(...)); // suggestion text now ABSENT
  break;
```

The point: once `exchange_suggested === true`, the suggestion text is
physically not in the prompt, so Luna cannot re-suggest it. That is what kills
the loop.

### Phase 4 — Code-owned step detector (transitions live in code, not the prompt)

Add a function that runs each turn AFTER receiving the customer message and
BEFORE building the prompt, to advance `metadata.step` / set `slots` /
flip latches. Ask me which detection style I want before implementing:
- (a) a small dedicated LLM classifier call per turn (robust, small cost), or
- (b) keyword matching (free, instant, more brittle).

It must handle at minimum:
- entering a flow (sets `flow`, `step='validate'`)
- validation success → `step='collect_item_reason'`
- reason captured → `step='exchange_suggested'`
- after suggestion sent → set `exchange_suggested=true`,
  `step='awaiting_exchange_decision'`
- customer DECLINES exchange (catch "no", "i want a refund", "Nooo", "!!!",
  Arabic "لا"/"عايز فلوسي", Franco "la2"/"3ayez felosy") → `step='ready_to_escalate'`
- mid-flow re-classification (exchange ↔ refund) per the existing prompt rule

Do NOT let the main generation call decide transitions.

### Phase 5 (separate, lower priority) — investigate the turn-1 bug

In the production log, the FIRST "Can i exchange an order?" returned "policy
doesn't allow exchanges or refunds" — meaning the exchange module didn't load
and a knowledge-base FAQ or core-identity rule overrode it. Investigate:
- whether `analyzeContext` sets `isExchangeIntent` on the bare phrase
  "Can i exchange an order?"
- whether a stale KB FAQ ("no refunds") outranks the module per the knowledge
  hierarchy.
Report findings; do not fix until Phases 1-4 are reviewed.

## Constraints

- One phase = one commit. Stop and let me review between phases.
- Do not refactor unrelated code or "clean up" things I didn't ask about.
- Preserve all trilingual behavior (English / Egyptian Arabic / Franco Arabic).
- Match existing DB write shapes — read the current escalation/metadata writes
  before mirroring them; don't invent column names.
- Apply the same state-machine pattern to order-taking LATER, only after
  exchange/refund is reviewed. PLACE_ORDER already gives a clean terminal
  action, so it's lower risk — don't touch it yet.
- If a proposed change conflicts with how the code actually works, stop and ask.