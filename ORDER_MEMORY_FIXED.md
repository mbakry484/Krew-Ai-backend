# Order Memory System - Fixed

## Problem

The metadata was being updated AFTER the AI reply was generated, which meant:
1. Customer responses to awaiting states weren't being captured before AI generation
2. Luna couldn't see the collected info when generating her next reply
3. The order state was always one step behind

## Solution

The metadata is now properly managed in the correct order:

### Flow for Every Incoming Message

```
1. Find/create conversation by sender_id + brand_id
2. Load metadata from conversation.metadata
3. Update collected_info BEFORE AI call (capture customer's response)
4. Fetch last 10 messages
5. Save incoming message
6. Map conversation history
7. Fetch business name
8. Generate AI reply with CURRENT metadata state
9. Update metadata based on AI reply (detect products, order intent, awaiting state)
10. Check for ORDER_READY
11. Send reply
12. Save AI reply
13. Save updated metadata back to database
```

## Critical Changes Made

### 1. **Metadata Loading (Line 123-128)**
```javascript
// Load metadata from database (CRITICAL - this is Luna's memory)
let metadata = defaultMetadata;
if (conversation?.metadata && typeof conversation.metadata === 'object') {
  metadata = { ...defaultMetadata, ...conversation.metadata };
}
console.log(`💾 Metadata: ${JSON.stringify(metadata)}`);
```

### 2. **Capture Collected Info BEFORE AI Call (Line 130-137)**
```javascript
// Update collected info BEFORE generating reply (capture customer's response to previous awaiting state)
if (metadata.awaiting === 'name') {
  metadata.collected_info.name = messageText.trim();
} else if (metadata.awaiting === 'phone') {
  metadata.collected_info.phone = messageText.trim();
} else if (metadata.awaiting === 'address') {
  metadata.collected_info.address = messageText.trim();
}
```

**This is the key fix!** Previously, this was happening AFTER the AI reply, so Luna never saw the collected info.

### 3. **Generate AI Reply with Current State (Line 171-183)**
```javascript
// Generate AI reply with current metadata state
const aiReply = await generateReply(
  messageText,
  knowledgeBaseRows || [],
  products || [],
  brand_id,
  conversationHistory,
  metadata,  // ← Now includes the just-collected info!
  businessName
);
```

### 4. **Update Metadata After AI Reply (Line 186-193)**
```javascript
// Update metadata based on AI reply (detect new products, order intent, and what Luna is asking for)
metadata = await updateMetadataFromConversation(
  messageText,
  aiReply,
  metadata,
  products || [],
  previousMessages || []
);
```

This function now:
- Extracts newly mentioned products → adds to `discussed_products`
- Detects order intent → sets `current_order`
- Detects what Luna is asking for → updates `awaiting`
- Does NOT override collected_info (already captured in step 2)

### 5. **Save Metadata (Line 217-221)**
```javascript
// Save updated metadata (CRITICAL - this preserves order state across messages)
await supabase
  .from('conversations')
  .update({ metadata })
  .eq('id', conversation.id);
```

## Example Conversation Flow

### Message 1: Customer asks about products
```
📨 867797979570471: "What products do you have?"
🔍 Brand found: abc-123
💾 Metadata: {"discussed_products":[],"current_order":null,"collected_info":{"name":null,"phone":null,"address":null},"awaiting":null}
🤖 Luna reply: "We have Premium Hoodie (299 EGP) and Classic T-Shirt (149 EGP)"
✅ Sent to 867797979570471
```

**Metadata after:** Products added to discussed_products, awaiting=null

---

### Message 2: Customer wants to order
```
📨 867797979570471: "I want the hoodie"
🔍 Brand found: abc-123
💾 Metadata: {"discussed_products":[{"index":1,"name":"Premium Hoodie","price":299}],"current_order":null,"collected_info":{"name":null,"phone":null,"address":null},"awaiting":null}
🤖 Luna reply: "Perfect! What's your full name?"
✅ Sent to 867797979570471
```

**Metadata after:** current_order set to Premium Hoodie, awaiting='name'

---

### Message 3: Customer provides name
```
📨 867797979570471: "Ahmed Hassan"
🔍 Brand found: abc-123
💾 Metadata: {"discussed_products":[...],"current_order":{...},"collected_info":{"name":null,"phone":null,"address":null},"awaiting":"name"}
```

**BEFORE AI call:** metadata.collected_info.name = "Ahmed Hassan"

```
🤖 Luna reply: "Thanks Ahmed! What's your phone number?"
✅ Sent to 867797979570471
```

**Metadata after:** collected_info.name="Ahmed Hassan", awaiting='phone'

---

### Message 4: Customer provides phone
```
📨 867797979570471: "+20 123 456 7890"
🔍 Brand found: abc-123
💾 Metadata: {"discussed_products":[...],"current_order":{...},"collected_info":{"name":"Ahmed Hassan","phone":null,"address":null},"awaiting":"phone"}
```

**BEFORE AI call:** metadata.collected_info.phone = "+20 123 456 7890"

```
🤖 Luna reply: "Perfect! What's your delivery address?"
✅ Sent to 867797979570471
```

**Metadata after:** collected_info.phone="+20 123 456 7890", awaiting='address'

---

### Message 5: Customer provides address
```
📨 867797979570471: "123 Main St, Cairo"
🔍 Brand found: abc-123
💾 Metadata: {"discussed_products":[...],"current_order":{...},"collected_info":{"name":"Ahmed Hassan","phone":"+20 123 456 7890","address":null},"awaiting":"address"}
```

**BEFORE AI call:** metadata.collected_info.address = "123 Main St, Cairo"

```
🤖 Luna reply: "✅ Order Summary:
• Product: Premium Hoodie
• Price: 299 EGP
• Name: Ahmed Hassan
• Phone: +20 123 456 7890
• Address: 123 Main St, Cairo

Can you confirm this order?"
✅ Sent to 867797979570471
```

**Metadata after:** All info collected, awaiting='confirmation'

---

### Message 6: Customer confirms
```
📨 867797979570471: "Yes, confirmed"
🔍 Brand found: abc-123
💾 Metadata: {"discussed_products":[...],"current_order":{...},"collected_info":{"name":"Ahmed Hassan","phone":"+20 123 456 7890","address":"123 Main St, Cairo"},"awaiting":"confirmation"}
🤖 Luna reply: "ORDER_READY"
✅ Shopify order created: #1234
✅ Sent to 867797979570471
```

**Metadata after:** Reset to defaults (order completed)

## System Prompt Integration

The system prompt now includes the current order state (from [lib/claude.js](lib/claude.js:88-130)):

```
CURRENT ORDER STATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Products discussed in this conversation:
  1. Premium Hoodie — 299 EGP
  2. Classic T-Shirt — 149 EGP

Currently ordering: Premium Hoodie (299 EGP)

Information collected so far:
  • Name: Ahmed Hassan
  • Phone: +20 123 456 7890
  • Address: 123 Main St, Cairo

Currently waiting for: order confirmation
```

Luna sees this BEFORE generating her reply, so she knows:
- ✅ What products have been discussed
- ✅ What product is being ordered
- ✅ What info has been collected
- ✅ What she should ask for next

## Key Functions

### `updateMetadataFromConversation()` (Line 252-296)
**Purpose:** Update metadata based on AI reply

**Does:**
- ✅ Extract product mentions from Luna's reply → add to discussed_products
- ✅ Detect order intent → set current_order
- ✅ Detect what Luna is asking for → update awaiting

**Does NOT:**
- ❌ Override collected_info (already captured before AI call)

### `detectAwaitingState()` (Line 333-356)
**Purpose:** Detect what Luna is currently asking for

**Looks for keywords:**
- "name" / "اسم" / "ism" → awaiting='name'
- "phone" / "number" / "رقم" / "ra2m" → awaiting='phone'
- "address" / "location" / "عنوان" / "3onwan" → awaiting='address'
- "confirm" / "تأكيد" / "ta2kid" (when all info collected) → awaiting='confirmation'

### `extractProductMentions()` (Line 310-331)
**Purpose:** Find products mentioned in Luna's reply

**How:** Checks if product.name appears in aiReply (case-insensitive)

### `identifyOrderedProduct()` (Line 378-413)
**Purpose:** Figure out which product customer wants to order

**Strategies:**
1. Check for "first one", "number 1", "الأول" → return discussed_products[0]
2. Check if product name mentioned in customer message
3. If only 1 product discussed → assume that's what they want

## Testing the Fix

Run a test conversation:

1. Customer: "What do you have?"
   - Metadata: products added, awaiting=null

2. Customer: "I want the hoodie"
   - Metadata: current_order set, awaiting='name'

3. Customer: "Ahmed"
   - **Before AI:** collected_info.name = "Ahmed"
   - Luna sees name in system prompt
   - Metadata: name saved, awaiting='phone'

If step 3 works correctly (Luna doesn't ask for name again), the fix is working!

## Database Schema

The `conversations` table must have a `metadata` JSONB column:

```sql
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{
  "discussed_products": [],
  "current_order": null,
  "collected_info": {"name": null, "phone": null, "address": null},
  "awaiting": null
}'::jsonb;
```

Run the migration: `psql < add-order-tracking.sql`

## Summary

✅ **Fixed:** Metadata is now loaded BEFORE AI generation
✅ **Fixed:** Collected info is captured BEFORE AI call
✅ **Fixed:** Metadata is saved AFTER every message
✅ **Fixed:** System prompt includes current order state
✅ **Fixed:** Luna has full memory of order progress

The order memory system is now fully functional!
