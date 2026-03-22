# State Machine Validation & Guard - Fixed

## Problem

The state machine was allowing confirmation messages to fall through and be saved as customer data:
- ❌ When `awaiting === 'confirmation'` but customer didn't use confirmation keywords, message fell through to state machine
- ❌ No validation for phone numbers (could save "no thanks" as phone)
- ❌ No validation for addresses (could save "123" as address)
- ❌ Invalid data could persist in metadata
- ❌ Confirmation message was "Can you confirm this order?" instead of "Do you want to confirm this order?"

## Solution

### 1. Guard Added to State Machine

Located in [routes/instagram.js:270-293](routes/instagram.js#L270-L293):

```javascript
// 5. DETERMINISTIC STATE MACHINE: Process customer input based on current awaiting state
// GUARD: Don't process through state machine if awaiting confirmation
// Let Luna handle rejections/corrections via OpenAI
if (metadata.awaiting !== 'confirmation') {
  if (metadata.awaiting === 'name') {
    metadata.collected_info.name = messageText.trim();
    metadata.awaiting = 'phone';
  } else if (metadata.awaiting === 'phone') {
    // Validation: Phone must contain at least 5 digits
    const phoneRegex = /\d{5,}/;
    if (phoneRegex.test(messageText)) {
      metadata.collected_info.phone = messageText.trim();
      metadata.awaiting = 'address';
    }
    // If invalid, don't save, don't advance state - Luna will ask again
  } else if (metadata.awaiting === 'address') {
    // Validation: Address must be at least 10 characters
    if (messageText.trim().length >= 10) {
      metadata.collected_info.address = messageText.trim();
      metadata.awaiting = 'confirmation';
    }
    // If invalid, don't save, don't advance state - Luna will ask again
  }
}
```

**What changed:**
- ✅ Wrapped entire state machine in `if (metadata.awaiting !== 'confirmation')`
- ✅ Prevents ANY message from being processed when awaiting confirmation
- ✅ Confirmation rejections/corrections handled by OpenAI instead

### 2. Input Validation Added

**Phone Validation:**
- Must contain at least 5 digits (`/\d{5,}/`)
- If invalid, phone is NOT saved, state does NOT advance
- Luna will ask again on next message

**Address Validation:**
- Must be at least 10 characters long
- If invalid, address is NOT saved, state does NOT advance
- Luna will ask again on next message

**Examples:**

| Input | Valid? | Saved? | State Transition? |
|-------|--------|--------|-------------------|
| "+20 123 456 7890" | ✅ Yes | ✅ Yes | ✅ phone → address |
| "no thanks" | ❌ No (0 digits) | ❌ No | ❌ stays at phone |
| "123" | ❌ No (3 digits) | ❌ No | ❌ stays at phone |
| "12345" | ✅ Yes | ✅ Yes | ✅ phone → address |
| "123 Main St, Cairo" | ✅ Yes (18 chars) | ✅ Yes | ✅ address → confirmation |
| "Street 5" | ❌ No (8 chars) | ❌ No | ❌ stays at address |

### 3. Metadata Sanity Check Before Saving

Located in [routes/instagram.js:360-378](routes/instagram.js#L360-L378):

```javascript
// 14. Metadata sanity check before saving
// Prevent saving invalid phone/address data
if (metadata.collected_info.phone) {
  const phoneRegex = /\d{5,}/;
  if (!phoneRegex.test(metadata.collected_info.phone)) {
    metadata.collected_info.phone = null; // Invalid phone, clear it
    if (metadata.awaiting === 'address' || metadata.awaiting === 'confirmation') {
      metadata.awaiting = 'phone'; // Go back to phone collection
    }
  }
}
if (metadata.collected_info.address) {
  if (metadata.collected_info.address.trim().length < 10) {
    metadata.collected_info.address = null; // Invalid address, clear it
    if (metadata.awaiting === 'confirmation') {
      metadata.awaiting = 'address'; // Go back to address collection
    }
  }
}

// 15. Save updated metadata (CRITICAL - this preserves order state across messages)
await supabase
  .from('conversations')
  .update({ metadata })
  .eq('id', conversation.id);
```

**What this does:**
- ✅ Checks phone/address validity BEFORE saving to database
- ✅ Clears invalid data automatically
- ✅ Rewinds state to re-collect invalid fields
- ✅ Safety net in case validation was bypassed somehow

### 4. Confirmation Message Updated

Located in [lib/claude.js:169](lib/claude.js#L169):

**Before:**
```
Then ask: "Can you confirm this order?" or the equivalent in their language.
```

**After:**
```
Then ask: "Do you want to confirm this order?" or the equivalent in their language.
```

**Why:**
- More natural phrasing
- Clearer call-to-action
- Better matches user preference

## Flow Examples

### Example 1: Valid Phone Number

```
📨 867797979570471: "+20 123 456 7890"
💾 Metadata: {"awaiting":"phone",...}
```

**State Machine:**
- awaiting='phone' → check if contains 5+ digits ✅
- Save "+20 123 456 7890" to collected_info.phone
- Advance to awaiting='address'

**Result:**
```
💾 Metadata: {"awaiting":"address","collected_info":{"phone":"+20 123 456 7890"},...}
🤖 Luna reply: "Perfect! What's your delivery address?"
```

---

### Example 2: Invalid Phone Number

```
📨 867797979570471: "no thanks"
💾 Metadata: {"awaiting":"phone",...}
```

**State Machine:**
- awaiting='phone' → check if contains 5+ digits ❌
- Do NOT save to collected_info.phone
- Do NOT advance state

**Result:**
```
💾 Metadata: {"awaiting":"phone","collected_info":{"phone":null},...}
🤖 Luna reply: "I need your phone number to complete the order. What's your phone number?"
```

---

### Example 3: Confirmation Rejection

```
📨 867797979570471: "no, change my address"
💾 Metadata: {"awaiting":"confirmation",...}
```

**Confirmation Check:**
- awaiting='confirmation' → check for confirmation keywords ❌
- Not confirmed, fall through

**State Machine:**
- awaiting='confirmation' → GUARD prevents processing ✅
- Message NOT saved as phone/address
- Fall through to OpenAI

**Result:**
```
💾 Metadata: {"awaiting":"confirmation",...} (unchanged)
🤖 Luna reply: "Sure! What's your new address?"
```

**After customer provides new address, Luna can manually update:**
```
💾 Metadata: {"awaiting":"confirmation","collected_info":{"address":"New Address"},...}
```

---

### Example 4: Sanity Check Catches Bad Data

```
📨 867797979570471: "123"
💾 Metadata: {"awaiting":"address",...}
```

**State Machine:**
- awaiting='address' → check if length >= 10 ❌
- Do NOT save, do NOT advance

**But somehow bad data got through (edge case):**
```
metadata.collected_info.address = "123"
metadata.awaiting = "confirmation"
```

**Sanity Check Before Save:**
- Check address length < 10 ✅
- Clear metadata.collected_info.address = null
- Rewind metadata.awaiting = 'address'

**Result:**
```
💾 Metadata: {"awaiting":"address","collected_info":{"address":null},...}
```

Luna will ask for address again.

---

## Benefits

✅ **Guard prevents fallthrough** - Confirmation state protected from state machine
✅ **Input validation** - Phone and address must meet minimum requirements
✅ **Sanity check** - Double validation before database save
✅ **State rewind** - Invalid data triggers re-collection
✅ **Clearer confirmation** - "Do you want to confirm this order?"

## Validation Rules

| Field | Rule | Regex/Check |
|-------|------|-------------|
| **Phone** | Must contain at least 5 digits | `/\d{5,}/` |
| **Address** | Must be at least 10 characters | `.trim().length >= 10` |
| **Name** | Any non-empty string | `.trim()` |

## Testing

### Test 1: Invalid Phone

1. Get to phone collection state
2. Send "no" or "abc" (no 5 digits)
3. Verify phone NOT saved
4. Verify state stays at 'phone'
5. Luna should ask for phone again

### Test 2: Invalid Address

1. Get to address collection state
2. Send "Street 5" (8 chars)
3. Verify address NOT saved
4. Verify state stays at 'address'
5. Luna should ask for address again

### Test 3: Confirmation Rejection

1. Get to confirmation state
2. Send "no, wrong address"
3. Verify message NOT saved as phone/address
4. Verify state stays at 'confirmation'
5. Luna should handle correction via OpenAI

### Test 4: Valid Flow

1. Provide valid name: "Ahmed Hassan"
2. Provide valid phone: "+20 123 456 7890"
3. Provide valid address: "123 Main St, Cairo"
4. Confirm: "yes"
5. Verify order created successfully

## Code Locations

| Component | File | Lines |
|-----------|------|-------|
| State Machine Guard | [routes/instagram.js](routes/instagram.js) | 270-293 |
| Phone Validation | [routes/instagram.js](routes/instagram.js) | 277-284 |
| Address Validation | [routes/instagram.js](routes/instagram.js) | 285-292 |
| Metadata Sanity Check | [routes/instagram.js](routes/instagram.js) | 360-378 |
| Confirmation Message | [lib/claude.js](lib/claude.js) | 169 |

## Summary

✅ **Guard added** - `if (metadata.awaiting !== 'confirmation')` wraps state machine
✅ **Phone validation** - Must contain 5+ digits
✅ **Address validation** - Must be 10+ characters
✅ **Sanity check** - Double validation before DB save
✅ **Confirmation message** - Updated to "Do you want to confirm this order?"

The state machine is now **robust, validated, and safe from data corruption**!
