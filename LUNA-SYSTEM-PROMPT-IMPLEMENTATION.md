# Luna System Prompt Implementation

## Overview

This document describes the implementation of Luna's AI system prompts based on the Luna System Prompt Document v1.0. The system uses a modular, context-aware approach to optimize token usage while maintaining Luna's personality and capabilities across all customer interactions.

## Architecture

### 1. Modular Prompt System

Located in `lib/prompts/`, the system is broken down into specialized modules:

#### Core Modules

- **`core-identity.js`** - Luna's base personality and character (always included)
  - Identity: Customer service team member (not AI, not bot)
  - Language rules: English, Egyptian Arabic, Franco Arabic
  - Communication style and tone
  - Self-awareness guidelines

- **`order-taking.js`** - DM order flow
  - Information collection (name, phone, address, product)
  - Order confirmation format
  - ORDER_READY trigger system

- **`exchanges-refunds.js`** - Exchange and refund handling
  - Exchange reasons: size issues vs defective products
  - Refund policy enforcement
  - Escalation triggers: ESCALATE_EXCHANGE, ESCALATE_REFUND

- **`delivery-issues.js`** - Late order and delivery complaints
  - 7+ days → escalate (ESCALATE_DELIVERY)
  - <7 days → reassure with tracking

- **`policy-questions.js`** - Customer policy inquiries
  - Short, friendly summaries (2-4 lines max)
  - Never copy-paste full policy text

- **`product-catalog.js`** - Product availability and recommendations
  - Dynamic in-stock and out-of-stock lists
  - Image handling for visual search
  - Restock question handling

- **`escalation.js`** - Escalation rules and triggers
  - When to escalate
  - Escalation keywords
  - Post-escalation silence rule

- **`positive-messages.js`** - Compliments and praise handling
  - Warm, brief responses
  - No sales redirects

### 2. Intelligent Prompt Manager

**`lib/prompts/prompt-manager.js`** - Context-aware prompt assembly

#### Key Functions

```javascript
analyzeContext(customerMessage, conversationHistory, metadata)
```
Analyzes customer message to determine which prompt modules are needed:
- Order intent detection
- Exchange/refund intent
- Policy questions
- Delivery complaints
- Positive messages
- Product catalog needs
- Escalation triggers

```javascript
buildOptimizedPrompt({ ...params })
```
Assembles only the relevant prompt modules based on context analysis, significantly reducing token usage.

**Optimization Strategy:**
- Only includes prompts relevant to the current context
- Core identity + escalation rules always included
- Scenario-specific prompts added dynamically
- Product catalog only included when needed

## Escalation System

### Database Schema

Run `add-escalation-schema.sql` to add:

```sql
-- New columns in conversations table
is_escalated BOOLEAN DEFAULT FALSE
escalation_type TEXT  -- 'exchange', 'refund', 'delivery', 'general'
escalation_reason TEXT
escalated_at TIMESTAMP
escalated_by TEXT DEFAULT 'ai'
```

### Escalation Triggers

Luna uses specific keywords to trigger escalation:

| Keyword | Type | When Used |
|---------|------|-----------|
| `ESCALATE_EXCHANGE` | Exchange | After collecting exchange details + photos |
| `ESCALATE_REFUND` | Refund | After collecting refund request + order ID |
| `ESCALATE_DELIVERY` | Delivery | Order delayed 7+ days |
| `ESCALATE_GENERAL` | General | Off-topic, frustrated customers, job inquiries |

### Escalation Detection

```javascript
const { checkEscalation } = require('./lib/claude');

const aiResponse = await generateReply(...);
const escalation = checkEscalation(aiResponse);

if (escalation.shouldEscalate) {
  // Update conversation in database
  await supabase
    .from('conversations')
    .update({
      is_escalated: true,
      escalation_type: escalation.type,
      escalation_reason: escalation.reason,
      escalated_at: new Date().toISOString()
    })
    .eq('id', conversationId);
}
```

### Critical Rule

Once a conversation is escalated (`is_escalated = true`), Luna **MUST NOT** respond to any further messages until a team member manually clears the escalation flag.

**Implementation in webhook handler:**

```javascript
// Check if conversation is escalated before generating AI response
if (conversation.is_escalated) {
  console.log('⚠️  Conversation is escalated - skipping AI response');
  return; // Don't generate or send AI reply
}
```

## API Endpoints

### Escalation Management Routes

**`routes/escalations.js`** provides:

#### GET `/escalations`
Fetch all escalated conversations
```
Query params:
  - brand_id: UUID (required)
  - type: string (optional) - filter by escalation type
  - limit: number (optional, default 50)
```

#### POST `/escalations/:conversation_id/resolve`
Mark escalation as resolved (keeps conversation status = 'resolved')
```json
{
  "resolved_by": "team_member_name",
  "notes": "Issue resolved - refund processed"
}
```

#### POST `/escalations/:conversation_id/reopen`
Clear escalation flag to re-enable AI responses
```json
Response:
{
  "message": "Conversation reopened successfully - AI can now respond",
  "conversation": { ... }
}
```

#### GET `/escalations/stats`
Get escalation statistics by type
```
Query params:
  - brand_id: UUID (required)

Response:
{
  "total": 42,
  "by_type": {
    "exchange": 15,
    "refund": 10,
    "delivery": 12,
    "general": 5
  }
}
```

## Integration Guide

### Updating Instagram Webhook Handler

Add escalation check in `routes/instagram.js`:

```javascript
const { generateReply, checkEscalation } = require('../lib/claude');

// ... existing code ...

// Before generating AI response
if (conversation.is_escalated) {
  console.log(`⚠️  Conversation ${conversationId} is escalated - AI will not respond`);
  return; // Exit without generating reply
}

// Generate AI reply
const aiReply = await generateReply(
  customerMessage,
  knowledgeBaseRows,
  inStockProducts,
  outOfStockProducts,
  brandId,
  conversationHistory,
  metadata,
  businessName,
  imageUrl,
  storyContext
);

// Check if response triggers escalation
const escalation = checkEscalation(aiReply);

if (escalation.shouldEscalate) {
  // Update conversation
  await supabase
    .from('conversations')
    .update({
      is_escalated: true,
      escalation_type: escalation.type,
      escalation_reason: escalation.reason,
      escalated_at: new Date().toISOString()
    })
    .eq('id', conversationId);

  console.log(`🚨 Conversation escalated: ${escalation.type} - ${escalation.reason}`);

  // Optional: Send notification to team
  // await notifyTeam(brandId, conversationId, escalation);
}

// Send reply to customer (strip escalation keywords)
const cleanReply = aiReply
  .replace(/ESCALATE_EXCHANGE/gi, '')
  .replace(/ESCALATE_REFUND/gi, '')
  .replace(/ESCALATE_DELIVERY/gi, '')
  .replace(/ESCALATE_GENERAL/gi, '')
  .trim();

await sendDM(customerId, cleanReply);
```

## Future Enhancements

### 1. Exchange/Refund Request Tables

Create dedicated tables to track requests:

```sql
CREATE TABLE exchange_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  order_number TEXT,
  reason TEXT, -- 'size', 'defective'
  product_name TEXT,
  photo_urls TEXT[], -- Array of photo URLs
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'completed'
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE refund_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  order_number TEXT,
  reason TEXT,
  amount DECIMAL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 2. Team Notification System

Notify team members when escalations occur:
- Email notifications
- Slack/Discord webhooks
- In-app notifications
- SMS for urgent cases

### 3. Analytics Dashboard

Track Luna's performance:
- Response accuracy
- Escalation rates by type
- Average resolution time
- Customer satisfaction scores

## Testing

### Test Scenarios

1. **Order Flow**
   - Customer: "I want to order the first product"
   - Expected: Luna collects name, phone, address in one message

2. **Exchange (Defective)**
   - Customer: "I want to exchange this, it arrived damaged"
   - Expected: Luna asks for order number + photos → ESCALATE_EXCHANGE

3. **Refund (Size Issue)**
   - Customer: "Can I get a refund? Wrong size"
   - Expected: Luna explains no-refund policy, offers exchange

4. **Delivery Complaint (7+ days)**
   - Customer: "My order hasn't arrived, it's been 10 days"
   - Expected: Luna apologizes → ESCALATE_DELIVERY

5. **Positive Message**
   - Customer: "I love this dress! Amazing quality!"
   - Expected: Short, warm response without sales pitch

6. **Off-topic (Job Inquiry)**
   - Customer: "Are you hiring?"
   - Expected: ESCALATE_GENERAL

## Token Optimization

### Before (Old System)
Every response included:
- Full identity prompt
- Full order-taking flow
- Complete product catalog
- All knowledge base entries
- All scenario rules

**Average tokens: ~3,000-4,000 per request**

### After (New System)
Only includes:
- Core identity (always)
- Escalation rules (always)
- Context-relevant prompts (conditional)
- Product catalog only when needed
- Knowledge base (always, but optimized)

**Average tokens: ~1,500-2,500 per request**
**Savings: ~40% reduction in token usage**

## Maintenance

### Adding New Scenarios

1. Create new prompt module in `lib/prompts/[scenario-name].js`
2. Add detection logic in `prompt-manager.js` → `analyzeContext()`
3. Include module in `buildOptimizedPrompt()` when context matches
4. Test with sample conversations

### Updating Luna's Personality

Edit `lib/prompts/core-identity.js` - changes apply globally.

### Modifying Escalation Rules

Edit `lib/prompts/escalation.js` and update keywords in `lib/claude.js` → `checkEscalation()`.

## Support

For questions or issues with the Luna system:
1. Check this documentation
2. Review prompt modules in `lib/prompts/`
3. Test with `routes/ai.js` → `/ai/generate` endpoint
4. Monitor logs for context analysis output: `🤖 AI Context: {...}`
