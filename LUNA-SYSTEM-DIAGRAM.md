# Luna System Architecture Diagram

## High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CUSTOMER SENDS MESSAGE                          │
│                    (Instagram DM / Story Reply)                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    INSTAGRAM WEBHOOK HANDLER                        │
│                    (routes/instagram.js)                            │
├─────────────────────────────────────────────────────────────────────┤
│  1. Receive message                                                 │
│  2. Get/create conversation                                         │
│  3. ⚠️  CHECK: conversation.is_escalated?                           │
│     • YES → Exit (no AI response)                                   │
│     • NO → Continue ↓                                               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AI RESPONSE GENERATION                         │
│                        (lib/claude.js)                              │
├─────────────────────────────────────────────────────────────────────┤
│  generateReply() calls:                                             │
│    • buildOptimizedPrompt() ────────────────┐                       │
│    • OpenAI API (gpt-4o-mini)               │                       │
│    • checkEscalation()                      │                       │
└─────────────────────────────────────────────┼───────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    INTELLIGENT PROMPT MANAGER                       │
│                  (lib/prompts/prompt-manager.js)                    │
├─────────────────────────────────────────────────────────────────────┤
│  Step 1: analyzeContext(customerMessage)                            │
│    ├─ Detect order intent?                                          │
│    ├─ Detect exchange/refund intent?                                │
│    ├─ Detect delivery complaint?                                    │
│    ├─ Detect policy question?                                       │
│    ├─ Detect positive message?                                      │
│    └─ Detect escalation trigger?                                    │
│                                                                      │
│  Step 2: buildOptimizedPrompt()                                     │
│    ├─ ALWAYS include: core-identity.js                              │
│    ├─ ALWAYS include: escalation.js                                 │
│    └─ CONDITIONALLY include based on context:                       │
│       ├─ order-taking.js (if order intent)                          │
│       ├─ exchanges-refunds.js (if exchange/refund)                  │
│       ├─ policy-questions.js (if policy query)                      │
│       ├─ delivery-issues.js (if delivery complaint)                 │
│       ├─ product-catalog.js (if needs products)                     │
│       └─ positive-messages.js (if compliment)                       │
│                                                                      │
│  Returns: Optimized system prompt (~40% smaller)                    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      ESCALATION CHECK                               │
│                   checkEscalation(aiResponse)                       │
├─────────────────────────────────────────────────────────────────────┤
│  Check for keywords:                                                │
│    • ESCALATE_EXCHANGE → type: 'exchange'                           │
│    • ESCALATE_REFUND → type: 'refund'                               │
│    • ESCALATE_DELIVERY → type: 'delivery'                           │
│    • ESCALATE_GENERAL → type: 'general'                             │
│                                                                      │
│  Returns: { shouldEscalate, type, reason }                          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────┴───────────┐
                    │                       │
               YES  │  shouldEscalate?      │  NO
                    │                       │
         ┌──────────┴──────────┐            │
         ▼                     │            │
┌────────────────────┐         │            │
│  UPDATE DATABASE   │         │            │
├────────────────────┤         │            │
│ is_escalated=TRUE  │         │            │
│ escalation_type    │         │            │
│ escalation_reason  │         │            │
│ escalated_at       │         │            │
└──────────┬─────────┘         │            │
           │                   │            │
           ▼                   ▼            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SEND RESPONSE TO CUSTOMER                        │
│                (Strip escalation keywords first)                    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
                         ┌──────────────┐
                         │ CONVERSATION │
                         │   CONTINUES  │
                         └──────────────┘
```

## Escalation Management Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CONVERSATION ESCALATED                           │
│                   (is_escalated = TRUE)                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                │                               │
                ▼                               ▼
    ┌───────────────────────┐       ┌──────────────────────┐
    │   AI STOPS REPLYING   │       │  TEAM IS NOTIFIED    │
    │                       │       │  (future feature)    │
    │  Luna will not send   │       │                      │
    │  any more messages    │       │  • Email             │
    │  to this customer     │       │  • Slack/Discord     │
    │  until team clears    │       │  • In-app alert      │
    │  escalation flag      │       │                      │
    └───────────────────────┘       └──────────────────────┘
                │
                ▼
    ┌───────────────────────────────────────────────┐
    │         TEAM USES ESCALATION API             │
    │       (routes/escalations.js)                │
    ├───────────────────────────────────────────────┤
    │  GET /escalations                            │
    │    └─ List all escalated conversations       │
    │                                              │
    │  GET /escalations/stats                      │
    │    └─ Get escalation statistics              │
    │                                              │
    │  POST /escalations/:id/resolve               │
    │    └─ Mark as resolved (keep status)         │
    │                                              │
    │  POST /escalations/:id/reopen                │
    │    └─ Clear flag, re-enable AI responses     │
    └───────────────────────────────────────────────┘
```

## Module Loading Strategy

```
                    Customer Message Received
                              │
                              ▼
                   ┌──────────────────┐
                   │  Analyze Context │
                   └────────┬─────────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
    Order Intent?    Exchange Intent?   Policy Question?
          │                 │                 │
          ▼                 ▼                 ▼

┌─────────────────────────────────────────────────────────────┐
│                    PROMPT ASSEMBLY                          │
├─────────────────────────────────────────────────────────────┤
│  BASE (Always Loaded - ~2.0 KB)                             │
│    ├─ core-identity.js      1.2 KB                          │
│    └─ escalation.js          0.8 KB                          │
│                                                              │
│  + CONDITIONAL MODULES (~0.5-1.5 KB each)                   │
│    ├─ order-taking.js        1.5 KB  (if order)             │
│    ├─ exchanges-refunds.js   1.2 KB  (if exchange/refund)   │
│    ├─ delivery-issues.js     0.7 KB  (if delivery)          │
│    ├─ policy-questions.js    0.6 KB  (if policy)            │
│    ├─ product-catalog.js     1.0 KB  (if needs products)    │
│    └─ positive-messages.js   0.5 KB  (if compliment)        │
│                                                              │
│  RESULT: 2.0 KB - 7.5 KB (avg 3.5 KB)                       │
│  vs OLD SYSTEM: Always 10+ KB                               │
│                                                              │
│  SAVINGS: ~40% token reduction                              │
└─────────────────────────────────────────────────────────────┘
```

## Scenario-Based Flow Examples

### Example 1: Customer Orders Product

```
Customer: "I want to order the black dress"
                │
                ▼
      ┌─────────────────┐
      │ Context Analysis│
      └────────┬────────┘
               │
               ├─ Order intent: ✅ YES
               ├─ Needs products: ✅ YES
               └─ Exchange: ❌ NO
                │
                ▼
      ┌────────────────────┐
      │  Modules Loaded:   │
      ├────────────────────┤
      │  ✅ core-identity  │
      │  ✅ escalation     │
      │  ✅ order-taking   │
      │  ✅ product-catalog│
      └────────┬───────────┘
               │
               ▼
      AI: "Perfect! To confirm your order, I'll need:
           • Your full name
           • Phone number
           • Delivery address"
```

### Example 2: Customer Requests Exchange

```
Customer: "This dress arrived damaged, want to exchange"
                │
                ▼
      ┌─────────────────┐
      │ Context Analysis│
      └────────┬────────┘
               │
               ├─ Exchange intent: ✅ YES
               ├─ Order intent: ❌ NO
               └─ Needs products: ❌ NO
                │
                ▼
      ┌────────────────────────┐
      │    Modules Loaded:     │
      ├────────────────────────┤
      │  ✅ core-identity      │
      │  ✅ escalation         │
      │  ✅ exchanges-refunds  │
      └────────┬───────────────┘
               │
               ▼
      AI: "Sorry to hear that! To process your exchange, could you share:
           1. Your order number
           2. Clear photos of the defect (including tag)
           We'll take it from there!"
                │
                ▼
      [Customer provides photos + order#]
                │
                ▼
      AI: "Got it, thank you! ESCALATE_EXCHANGE"
                │
                ▼
      ┌────────────────────┐
      │  Escalation Check  │
      │  Detects keyword   │
      └────────┬───────────┘
               │
               ▼
      ┌────────────────────────┐
      │   Update Database      │
      │  is_escalated = TRUE   │
      │  type = 'exchange'     │
      └────────┬───────────────┘
               │
               ▼
      [Team takes over - Luna stops responding]
```

### Example 3: Positive Message

```
Customer: "I love this dress! Amazing quality!"
                │
                ▼
      ┌─────────────────┐
      │ Context Analysis│
      └────────┬────────┘
               │
               ├─ Positive: ✅ YES
               ├─ Order intent: ❌ NO
               └─ Needs products: ❌ NO
                │
                ▼
      ┌──────────────────────┐
      │   Modules Loaded:    │
      ├──────────────────────┤
      │  ✅ core-identity    │
      │  ✅ escalation       │
      │  ✅ positive-messages│
      └────────┬─────────────┘
               │
               ▼
      AI: "That genuinely made our day, thank you!! 🖤"

      [Smallest possible prompt - ~2.5 KB]
```

## Token Optimization Visualization

```
OLD SYSTEM (No Optimization):
┌─────────────────────────────────────────────────┐
│ ████████████████████████████████████████████    │ 10+ KB
│ ALL modules loaded for EVERY message           │
└─────────────────────────────────────────────────┘

NEW SYSTEM (Optimized):
Simple Query (Positive Message):
┌───────────────────────┐
│ ████████              │ ~2.5 KB (-75%)
└───────────────────────┘

Medium Query (Order):
┌────────────────────────────┐
│ ████████████████           │ ~3.5 KB (-65%)
└────────────────────────────┘

Complex Query (Order + Metadata):
┌──────────────────────────────────┐
│ ████████████████████             │ ~4.5 KB (-55%)
└──────────────────────────────────┘

Average Savings: ~40% across all queries
```

## Database Schema Visual

```
conversations table:
┌─────────────────────────────────────────────┐
│ id                 UUID PRIMARY KEY         │
│ brand_id           UUID                     │
│ customer_id        TEXT                     │
│ platform           TEXT                     │
│ status             TEXT                     │
│ created_at         TIMESTAMP                │
│ updated_at         TIMESTAMP                │
│                                              │
│ ========== NEW COLUMNS ==========           │
│ is_escalated       BOOLEAN  ← 🆕           │
│ escalation_type    TEXT     ← 🆕           │
│ escalation_reason  TEXT     ← 🆕           │
│ escalated_at       TIMESTAMP ← 🆕           │
│ escalated_by       TEXT     ← 🆕           │
└─────────────────────────────────────────────┘

escalated_conversations view:  ← 🆕
┌─────────────────────────────────────────────┐
│ Aggregates:                                  │
│  • All conversation data                     │
│  • message_count                             │
│  • last_message_at                           │
│                                              │
│ Filters: WHERE is_escalated = TRUE          │
└─────────────────────────────────────────────┘
```

---

## Key Symbols Legend

```
✅ = Included / Enabled
❌ = Not included / Disabled
🆕 = New feature / column
⚠️  = Critical check / warning
📦 = Module / Package
🔄 = Process / Flow
🚨 = Escalation
📊 = Data / Statistics
```
