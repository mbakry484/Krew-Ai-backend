# Instagram Webhook Event Filtering

Clean, efficient filtering of Instagram webhook events to process only real customer messages.

## Problem

Instagram webhooks send many event types:
- ❌ Echo messages (Luna's own replies)
- ❌ Read receipts
- ❌ Delivery receipts
- ❌ Typing indicators
- ✅ Customer messages (text)
- ✅ Customer messages (images)

**Previous behavior:**
- Logged undefined messages
- Processed unnecessary events
- Created noise in logs

## Solution

**New filtering logic** in [routes/instagram.js:128-179](routes/instagram.js#L128-L179):

```javascript
// 1. Check messaging exists
const messaging = entry.messaging?.[0];
if (!messaging) {
  res.sendStatus(200);
  return;
}

// 2. Filter out echo messages (Luna's own replies)
if (messaging.message?.is_echo) {
  res.sendStatus(200);
  return;
}

// 3. Filter out read receipts
if (messaging.read) {
  res.sendStatus(200);
  return;
}

// 4. Filter out delivery receipts
if (messaging.delivery) {
  res.sendStatus(200);
  return;
}

// 5. Validate sender/recipient
const senderId = messaging.sender?.id;
const recipientId = messaging.recipient?.id;

if (!senderId || !recipientId || senderId === recipientId) {
  res.sendStatus(200);
  return;
}

// 6. Extract message content
const customerMessage = messaging.message?.text;
const attachments = messaging.message?.attachments || [];
const imageAttachment = attachments.find(a => a.type === 'image');
const imageUrl = imageAttachment?.payload?.url || null;

// 7. Only proceed if there's actual content
if (!customerMessage && !imageUrl) {
  res.sendStatus(200);
  return;
}

// 8. NOW log - only real messages reach this point
console.log(`📨 ${senderId}: "${customerMessage || '[Image]'}"`);

// 9. Process the message
await handleIncomingMessage(messaging, recipientId);
```

## Event Types & Handling

| Event Type | Detection | Action |
|-----------|-----------|--------|
| **Echo** | `messaging.message?.is_echo === true` | Return 200, skip |
| **Read Receipt** | `messaging.read` exists | Return 200, skip |
| **Delivery Receipt** | `messaging.delivery` exists | Return 200, skip |
| **Text Message** | `messaging.message?.text` exists | Process ✅ |
| **Image Message** | `messaging.message?.attachments` with type=image | Process ✅ |
| **Invalid/Empty** | No text AND no image | Return 200, skip |

## Benefits

### 1. Clean Logs
**Before:**
```
📨 undefined: "undefined"
📨 undefined: "undefined"
📨 867797979570471: "Hello"
📨 undefined: "undefined"
```

**After:**
```
📨 867797979570471: "Hello"
📨 867797979570471: "[Image]"
📨 867797979570471: "What do you have?"
```

### 2. Reduced Processing
- No unnecessary database calls
- No AI API calls for non-messages
- Faster webhook response times

### 3. Accurate Metrics
- Only count real customer messages
- Better conversation analytics
- Clearer debugging

## Filter Order & Efficiency

Filters are ordered by **likelihood** (most common first):

1. **Messaging exists** (catches malformed webhooks)
2. **Echo check** (very common - every Luna reply)
3. **Read receipts** (common - customer reads message)
4. **Delivery receipts** (common - message delivered)
5. **Sender/recipient validation** (rare edge cases)
6. **Content validation** (ensures processable message)

**Why this order?**
- Exit early for common non-message events
- Minimize unnecessary checks
- Optimize for typical webhook traffic

## Webhook Response Strategy

All filtered events return `200 OK`:

```javascript
res.sendStatus(200);
return;
```

**Why return 200?**
- Instagram expects acknowledgment
- Prevents webhook retries
- Signals "received and handled"
- Even if "handled" means "ignored"

## Edge Cases Handled

### Case 1: Customer Deletes Message
**Event:** Deletion event (no message content)
**Handling:** Filtered by content validation (no text, no image)

### Case 2: Customer Sends Reaction
**Event:** Reaction event (emoji on message)
**Handling:** Filtered by content validation (no message object)

### Case 3: Customer Starts Typing
**Event:** Typing indicator
**Handling:** Filtered by content validation (no message text/image)

### Case 4: Connection Issues
**Event:** Malformed webhook payload
**Handling:** Filtered by messaging existence check

## Testing

### Test Script

Create `test-webhook-events.js`:

```javascript
const axios = require('axios');

const webhookUrl = 'http://localhost:3000/webhook/instagram';

async function testEvent(eventName, payload) {
  console.log(`\nTesting: ${eventName}`);

  const response = await axios.post(webhookUrl, payload);
  console.log(`Response: ${response.status}`);
}

// Test 1: Echo message (should be filtered)
testEvent('Echo Message', {
  object: 'instagram',
  entry: [{
    messaging: [{
      sender: { id: '123' },
      recipient: { id: '456' },
      message: {
        text: 'Hello',
        is_echo: true
      }
    }]
  }]
});

// Test 2: Read receipt (should be filtered)
testEvent('Read Receipt', {
  object: 'instagram',
  entry: [{
    messaging: [{
      sender: { id: '123' },
      recipient: { id: '456' },
      read: {
        watermark: 1234567890
      }
    }]
  }]
});

// Test 3: Real customer message (should process)
testEvent('Customer Message', {
  object: 'instagram',
  entry: [{
    messaging: [{
      sender: { id: '123' },
      recipient: { id: '456' },
      message: {
        mid: 'msg_123',
        text: 'Hello, do you have the red hoodie?'
      }
    }]
  }]
});

// Test 4: Customer image (should process)
testEvent('Customer Image', {
  object: 'instagram',
  entry: [{
    messaging: [{
      sender: { id: '123' },
      recipient: { id: '456' },
      message: {
        mid: 'msg_124',
        attachments: [{
          type: 'image',
          payload: {
            url: 'https://example.com/image.jpg'
          }
        }]
      }
    }]
  }]
});
```

### Expected Logs

**Echo Message Test:**
```
(No log - filtered)
```

**Read Receipt Test:**
```
(No log - filtered)
```

**Customer Message Test:**
```
📨 123: "Hello, do you have the red hoodie?"
🔍 Brand found: abc-123
🤖 Luna reply: "Yes! We have the red hoodie..."
✅ Sent to 123
```

**Customer Image Test:**
```
📨 123: "[Image]"
📸 Processing customer image with vector search...
🔍 Customer image described as: A red hoodie with white logo
🎯 Found 2 similar products
🤖 Luna reply (image match): "Yes! I found it!..."
✅ Sent to 123
```

## Monitoring

### Key Metrics

Track in production logs:

```javascript
// Add counters
let totalWebhooks = 0;
let echoCount = 0;
let readReceiptCount = 0;
let deliveryCount = 0;
let processedMessages = 0;

// Log periodically
setInterval(() => {
  console.log(`📊 Webhook Stats (last hour):
    Total: ${totalWebhooks}
    Echo: ${echoCount}
    Read: ${readReceiptCount}
    Delivery: ${deliveryCount}
    Processed: ${processedMessages}
    Filter Rate: ${((totalWebhooks - processedMessages) / totalWebhooks * 100).toFixed(1)}%
  `);
}, 3600000); // Every hour
```

### Expected Filter Rate

**Typical traffic:**
- 60-70% filtered (echo, receipts, etc.)
- 30-40% processed (real messages)

**If filter rate is < 50%:**
- Possible issue with event detection
- Check webhook configuration
- Review filtering logic

**If filter rate is > 90%:**
- Possible webhook misconfiguration
- Not receiving customer messages
- Check Instagram app settings

## Troubleshooting

### Issue: Real messages not processing

**Check:**
1. Is `is_echo` incorrectly true?
2. Is message content actually empty?
3. Is sender ID missing?

**Debug:**
```javascript
console.log('Full messaging object:', JSON.stringify(messaging, null, 2));
```

---

### Issue: Still seeing undefined in logs

**Possible causes:**
1. Old code path still active
2. Different webhook endpoint
3. Error thrown before filter

**Fix:** Ensure all webhook paths use new filtering logic.

---

### Issue: Webhook retries

**Symptom:** Instagram retries same event multiple times

**Cause:** Not returning 200 status

**Fix:** Ensure all filter paths call `res.sendStatus(200)`

---

## Performance Impact

### Before Filtering

**Every webhook triggered:**
- Database query (integration lookup)
- Database query (knowledge base)
- Database query (products)
- Database query (conversation)
- OpenAI API call
- Database writes (messages)

**Cost per echo/receipt:** ~$0.002 + DB overhead

### After Filtering

**Filtered events trigger:**
- Nothing ✅

**Cost per filtered event:** $0

### Savings

**Example traffic (1000 webhooks/day):**
- 700 filtered events
- 300 real messages

**Before:** 1000 × $0.002 = $2/day
**After:** 300 × $0.002 = $0.60/day
**Savings:** $1.40/day = ~$500/year

## Code References

| File | Lines | Purpose |
|------|-------|---------|
| [routes/instagram.js](routes/instagram.js) | 128-179 | Webhook filtering logic |
| [routes/instagram.js](routes/instagram.js) | 193-202 | Message handler (simplified) |

## Future Enhancements

- [ ] Rate limiting per sender
- [ ] Spam detection
- [ ] Webhook signature verification
- [ ] Event type analytics dashboard
- [ ] Automatic retry handling
- [ ] Webhook health monitoring

---

**Summary:**

✅ Clean logs (no undefined messages)
✅ Efficient processing (only real messages)
✅ Cost savings (~70% reduction)
✅ Better debugging experience
✅ Accurate conversation metrics

The webhook filtering system is production-ready and significantly improves system efficiency! 🚀
