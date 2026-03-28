# Luna System - File Structure

## New Files Created

### Prompt System Modules (`lib/prompts/`)

```
lib/prompts/
├── core-identity.js         ← Luna's base personality (ALWAYS included)
│   • Identity & character
│   • Language rules (English, Arabic, Franco)
│   • Communication style
│   • Self-awareness guidelines
│
├── order-taking.js          ← DM order flow (conditional)
│   • Information collection
│   • Order confirmation format
│   • ORDER_READY trigger
│   • Metadata integration
│
├── exchanges-refunds.js     ← Exchange/refund handling (conditional)
│   • Size issues vs defective products
│   • Refund policy enforcement
│   • ESCALATE_EXCHANGE & ESCALATE_REFUND triggers
│
├── policy-questions.js      ← Policy inquiries (conditional)
│   • Short, friendly summaries
│   • No full policy copy-paste
│   • 2-4 lines maximum
│
├── delivery-issues.js       ← Delivery complaints (conditional)
│   • 7+ days → escalate
│   • <7 days → reassure
│   • ESCALATE_DELIVERY trigger
│
├── product-catalog.js       ← Product availability (conditional)
│   • Dynamic in-stock/OOS lists
│   • Image handling
│   • Restock questions
│
├── escalation.js            ← Escalation rules (ALWAYS included)
│   • When to escalate
│   • Escalation keywords
│   • Post-escalation silence rule
│
├── positive-messages.js     ← Compliments handling (conditional)
│   • Warm, brief responses
│   • No sales redirects
│
└── prompt-manager.js        ← ORCHESTRATOR
    • analyzeContext() - Detects intent
    • buildOptimizedPrompt() - Assembles relevant prompts
    • Token optimization logic
```

### API Routes

```
routes/
└── escalations.js           ← NEW - Escalation management
    • GET /escalations - List all escalated conversations
    • GET /escalations/stats - Get statistics
    • POST /escalations/:id/resolve - Mark as resolved
    • POST /escalations/:id/reopen - Re-enable AI
```

### Database Schema

```
add-escalation-schema.sql    ← NEW - Database migration
• Adds escalation columns to conversations table
• Creates escalated_conversations view
• Adds indexes for performance
```

### Documentation

```
LUNA-SYSTEM-PROMPT-IMPLEMENTATION.md   ← Full technical docs
• Architecture overview
• Integration guide
• API documentation
• Future enhancements
• Testing guide

LUNA-QUICK-REFERENCE.md                ← Daily use reference
• Luna's identity rules
• Scenario playbook
• Escalation management
• Troubleshooting

IMPLEMENTATION-SUMMARY.md              ← This implementation summary
• What was implemented
• Test results
• Integration steps
• Performance improvements

LUNA-FILE-STRUCTURE.md                 ← This file
• File organization
• Module purposes
• Import structure
```

### Testing

```
test-luna-system.js          ← Comprehensive test suite
• 17 test scenarios
• Context analysis validation
• Prompt building tests
• Escalation detection tests
• Multi-language support tests
```

## Modified Files

### Updated Core Files

```
lib/claude.js                ← UPDATED
• Added: import { buildOptimizedPrompt, analyzeContext }
• Added: checkEscalation() function
• Updated: generateReply() to use new prompt system
• Added: Context analysis logging
• Kept: buildSystemPrompt() for backward compatibility

server.js                    ← UPDATED
• Added: const escalationsRoutes = require('./routes/escalations')
• Added: app.use('/escalations', escalationsRoutes)
```

## File Dependencies

### Import Chain

```
server.js
└── routes/escalations.js
    └── lib/supabase.js

routes/instagram.js (webhook)
└── lib/claude.js
    ├── lib/supabase.js
    └── lib/prompts/prompt-manager.js
        ├── lib/prompts/core-identity.js
        ├── lib/prompts/order-taking.js
        ├── lib/prompts/exchanges-refunds.js
        ├── lib/prompts/policy-questions.js
        ├── lib/prompts/delivery-issues.js
        ├── lib/prompts/product-catalog.js
        ├── lib/prompts/escalation.js
        └── lib/prompts/positive-messages.js
```

## Usage Flow

### 1. Customer Message Arrives (Instagram Webhook)

```javascript
routes/instagram.js
  → checks: conversation.is_escalated?
  → if escalated: exit (no AI response)
  → if not: continue ↓
```

### 2. AI Response Generation

```javascript
lib/claude.js → generateReply()
  → calls: buildOptimizedPrompt() ↓
```

### 3. Context Analysis & Prompt Building

```javascript
lib/prompts/prompt-manager.js
  → analyzeContext(customerMessage) - Detects intent
  → buildOptimizedPrompt() - Assembles relevant modules
    ├── ALWAYS includes: core-identity.js
    ├── ALWAYS includes: escalation.js
    ├── CONDITIONAL: order-taking.js (if order intent)
    ├── CONDITIONAL: exchanges-refunds.js (if exchange/refund)
    ├── CONDITIONAL: policy-questions.js (if policy query)
    ├── CONDITIONAL: delivery-issues.js (if delivery complaint)
    ├── CONDITIONAL: product-catalog.js (if needs products)
    └── CONDITIONAL: positive-messages.js (if compliment)
  → returns optimized system prompt
```

### 4. Escalation Check

```javascript
lib/claude.js → checkEscalation(aiResponse)
  → checks for: ESCALATE_EXCHANGE
  → checks for: ESCALATE_REFUND
  → checks for: ESCALATE_DELIVERY
  → checks for: ESCALATE_GENERAL
  → returns: { shouldEscalate, type, reason }
```

### 5. Update Database & Send Response

```javascript
routes/instagram.js
  → if escalation.shouldEscalate:
    → UPDATE conversations SET is_escalated = TRUE
  → clean response (remove keywords)
  → send to customer via Meta API
```

### 6. Team Management

```javascript
routes/escalations.js
  → GET /escalations - View all escalated
  → POST /escalations/:id/resolve - Mark resolved
  → POST /escalations/:id/reopen - Re-enable AI
```

## Module Purposes Summary

| Module | Size | Purpose | Load Strategy |
|--------|------|---------|---------------|
| core-identity | ~1.2 KB | Base personality | Always |
| escalation | ~0.8 KB | Escalation rules | Always |
| order-taking | ~1.5 KB | Order flow | When order intent detected |
| exchanges-refunds | ~1.2 KB | Exchange/refund | When exchange/refund detected |
| policy-questions | ~0.6 KB | Policy responses | When policy question |
| delivery-issues | ~0.7 KB | Delivery complaints | When delivery complaint |
| product-catalog | ~1.0 KB | Product info | When needs products |
| positive-messages | ~0.5 KB | Compliments | When positive message |

**Total possible size:** ~7.5 KB
**Minimum size (simple query):** ~2.0 KB (core + escalation)
**Average size:** ~3.5 KB

## Database Tables Affected

```sql
conversations
  ├── is_escalated BOOLEAN      ← NEW
  ├── escalation_type TEXT      ← NEW
  ├── escalation_reason TEXT    ← NEW
  ├── escalated_at TIMESTAMP    ← NEW
  └── escalated_by TEXT         ← NEW

escalated_conversations (VIEW)  ← NEW
  └── Aggregated view of escalated conversations
```

## Environment Variables Required

```bash
# Existing (no changes)
OPENAI_API_KEY
SUPABASE_URL
SUPABASE_KEY

# No new environment variables needed!
```

## Testing Files

```
test-luna-system.js
  → Tests context analysis (17 scenarios)
  → Tests prompt building (optimization)
  → Tests escalation detection (4 types)
  → Tests metadata integration
  → Tests multi-language support

Run: node test-luna-system.js
```

## Integration Checklist

- [ ] 1. Run database migration: `add-escalation-schema.sql`
- [ ] 2. Update `routes/instagram.js` with escalation checks
- [ ] 3. Test with sample conversations
- [ ] 4. Verify escalation flow works
- [ ] 5. Check `/escalations` endpoints
- [ ] 6. Monitor logs for `🤖 AI Context:` output
- [ ] 7. Validate token usage reduction
- [ ] 8. Set up team notification system (optional)

## Key Files for Daily Operations

**For Developers:**
- `lib/prompts/prompt-manager.js` - Main orchestration logic
- `lib/claude.js` - AI integration
- `routes/escalations.js` - Escalation API

**For Luna Tuning:**
- `lib/prompts/core-identity.js` - Adjust Luna's personality
- `lib/prompts/*.js` - Modify scenario-specific responses

**For Testing:**
- `test-luna-system.js` - Run comprehensive tests
- `LUNA-QUICK-REFERENCE.md` - Test scenarios reference

**For Documentation:**
- `LUNA-SYSTEM-PROMPT-IMPLEMENTATION.md` - Technical details
- `LUNA-QUICK-REFERENCE.md` - Quick lookup guide
- `IMPLEMENTATION-SUMMARY.md` - High-level overview

---

**Total Files Created:** 15
**Total Files Modified:** 2
**Lines of Code Added:** ~1,500+
**Documentation Pages:** 4
**Test Scenarios:** 17
