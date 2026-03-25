# Product Availability Management

Luna now intelligently handles both in-stock and out-of-stock products, ensuring customers get honest information and appropriate recommendations.

## Overview

The system fetches **ALL products** from the database but clearly separates them into two categories:
- ✅ **In-Stock Products** - Available for immediate ordering
- ❌ **Out-of-Stock Products** - Acknowledged but cannot be ordered

## How It Works

### 1. Product Fetching

**Location:** [routes/instagram.js:191-202](routes/instagram.js#L191-L202)

```javascript
// Fetch ALL products - both in stock and out of stock
const { data: products } = await supabase
  .from('products')
  .select('name, price, variants, image_url, shopify_product_id, in_stock')
  .eq('brand_id', brand_id)
  .not('price', 'is', null)
  .gt('price', 0)
  .order('name', { ascending: true });

// Separate into available and unavailable
const inStockProducts = products?.filter(p => p.in_stock) || [];
const outOfStockProducts = products?.filter(p => !p.in_stock) || [];
```

### 2. System Prompt Structure

**Location:** [lib/claude.js:283-318](lib/claude.js#L283-L318)

The AI receives products in two clearly labeled sections:

```
🛒 PRODUCT CATALOG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AVAILABLE PRODUCTS (can be ordered):
1. Red Hoodie - 599 EGP ✅ In Stock
2. Blue T-Shirt - 299 EGP ✅ In Stock
...

OUT OF STOCK PRODUCTS (cannot be ordered right now):
1. Black Jacket - 899 EGP ❌ Out of Stock
2. Grey Sweater - 499 EGP ❌ Out of Stock
...

RULES FOR PRODUCT AVAILABILITY:
- Only offer to take orders for IN STOCK products
- If asked about an out of stock product → acknowledge it exists,
  state it's currently unavailable, suggest similar in-stock alternatives
- Never pretend an out of stock product is available
- If customer asks "what do you have?" → only list in-stock products
- If customer asks about a specific product that's OOS → tell them
  honestly and offer alternatives
```

## AI Behavior Scenarios

### Scenario 1: "What products do you have?"

**Expected Response:**
```
We have some great pieces available right now! Here are our in-stock items:

1. Red Hoodie - 599 EGP
2. Blue T-Shirt - 299 EGP
3. Black Cap - 199 EGP

Would you like to know more about any of these?
```

**Note:** Only lists in-stock products.

---

### Scenario 2: Customer Asks About Out-of-Stock Product

**Customer:** "Do you have the Black Jacket?"

**Expected Response:**
```
I do know about the Black Jacket (899 EGP), but unfortunately
it's currently out of stock 😔

We have similar options available:
- Red Hoodie - 599 EGP ✅ In Stock
- Grey Sweater - 499 EGP ✅ In Stock

Would any of these work for you? Or I can let you know when the
Black Jacket is back!
```

**Note:** Acknowledges the product exists, states availability honestly, suggests alternatives.

---

### Scenario 3: Customer Tries to Order OOS Product

**Customer:** "I want to order the Grey Sweater"

**Expected Response:**
```
I'd love to help, but the Grey Sweater is currently out of stock ❌

However, we have these similar items available:
- Red Hoodie - 599 EGP ✅ In Stock
- Blue T-Shirt - 299 EGP ✅ In Stock

Would you like to order one of these instead? Or I can help you
find something else!
```

**Note:** Politely declines, offers alternatives.

---

### Scenario 4: "Show me everything"

**Expected Response:**
```
Here's everything we have available for order right now:

✅ In Stock:
1. Red Hoodie - 599 EGP
2. Blue T-Shirt - 299 EGP
3. Black Cap - 199 EGP

(We also have some items that are temporarily out of stock.
Let me know if you're looking for something specific!)

Which one catches your eye? 😊
```

**Note:** Focuses on in-stock products, mentions OOS products exist without listing them all.

---

## Implementation Details

### Updated Function Signatures

**generateReply()** - [lib/claude.js:55-65](lib/claude.js#L55-L65)
```javascript
async function generateReply(
  customerMessage,
  knowledgeBaseRows,
  inStockProducts,      // NEW: Separated
  outOfStockProducts,   // NEW: Separated
  brandId,
  conversationHistory,
  metadata,
  businessName,
  imageUrl
)
```

**buildSystemPrompt()** - [lib/claude.js:129](lib/claude.js#L129)
```javascript
function buildSystemPrompt(
  businessName,
  knowledgeBaseRows,
  inStockProducts,      // NEW: Separated
  outOfStockProducts,   // NEW: Separated
  metadata
)
```

### Product List Formatting

**In-Stock:**
```javascript
const inStockList = (inStockProducts || []).slice(0, 30).map((p, i) =>
  `${i + 1}. ${p.name} - ${p.price} EGP ✅ In Stock`
).join('\n');
```

**Out-of-Stock:**
```javascript
const outOfStockList = (outOfStockProducts || []).slice(0, 30).map((p, i) =>
  `${i + 1}. ${p.name} - ${p.price} EGP ❌ Out of Stock`
).join('\n');
```

### Visual Indicators

| Symbol | Meaning |
|--------|---------|
| ✅ | In Stock - Can be ordered |
| ❌ | Out of Stock - Cannot be ordered |

## Order Processing

### Metadata Tracking

Only **in-stock products** are added to order metadata:

**Location:** [routes/instagram.js:546](routes/instagram.js#L546)
```javascript
metadata = await updateMetadataFromConversation(
  messageText,
  aiReply,
  metadata,
  inStockProducts  // Only in-stock products
);
```

### Order Confirmation

The system **prevents orders for out-of-stock products** at multiple levels:

1. **AI Level:** Luna won't offer to order OOS products
2. **Metadata Level:** OOS products won't be added to `current_order`
3. **Validation Level:** Shopify API validates inventory before creating orders

## Image Search Integration

When customers send product images, the vector search **only returns in-stock products**:

**SQL Function:** [add-product-embeddings.sql:99](add-product-embeddings.sql#L99)
```sql
WHERE
  products.embedding IS NOT NULL
  AND products.brand_id = match_brand_id
  AND products.in_stock = true  -- Only in-stock!
  AND 1 - (products.embedding <=> query_embedding) > match_threshold
```

**Result:** Customers never see OOS products in image search results.

## Testing

### Test Script

```bash
node test-product-availability.js
```

**Verifies:**
- ✅ Products separated correctly
- ✅ System prompt includes both sections
- ✅ Availability rules are present
- ✅ Visual indicators (✅/❌) are used
- ✅ AI guidelines are clear

### Manual Testing

**Test conversation flow:**

1. **Ask about inventory:**
   - "What do you have?"
   - "Show me everything"

2. **Ask about OOS product:**
   - "Do you have [OOS Product]?"
   - "I want to order [OOS Product]"

3. **Try to order OOS:**
   - "I'll take the [OOS Product]"
   - "Can I buy [OOS Product]?"

**Expected:** Luna should handle each gracefully.

## Database Schema

### products Table

| Column | Type | Description |
|--------|------|-------------|
| `in_stock` | BOOLEAN | Product availability status |
| `availability` | TEXT | Legacy field ('in_stock', 'out_of_stock') |
| `variants` | JSONB | Variant inventory data |

### Stock Calculation

Stock status is calculated from variant inventory:

```javascript
const inStock = product.variants?.some(v => v.inventory_quantity > 0) ?? true;
```

**See:** [Stock Update Documentation](STOCK-UPDATE.md) for details on how `in_stock` is updated.

## Benefits

### 1. Customer Transparency
- Customers know exactly what's available
- No disappointment after attempting to order
- Builds trust with honest communication

### 2. Better UX
- Luna suggests alternatives for OOS products
- Customers can still learn about OOS items
- Smooth handling of inventory questions

### 3. Reduced Support Load
- Fewer "is this available?" questions
- Less confusion about stock status
- Clearer expectations

### 4. Sales Optimization
- Focus on available inventory
- Alternative product suggestions
- Opportunity to capture interested customers for future restocks

## Monitoring

### Key Metrics to Track

1. **OOS Inquiry Rate:** % of conversations mentioning OOS products
2. **Alternative Acceptance:** % of customers accepting suggested alternatives
3. **Order Completion:** % of conversations → successful orders
4. **Stock Question Rate:** How often customers ask about availability

### Log Patterns

**Watch for:**
```
📊 Product Breakdown:
   ✅ In Stock: 15
   ❌ Out of Stock: 9
```

**If OOS products >> In-stock:**
- Consider restocking popular items
- Review inventory management
- Update product sync frequency

## Troubleshooting

### Issue: All products showing as out of stock

**Check:**
```sql
SELECT COUNT(*) FILTER (WHERE in_stock = true) as in_stock_count,
       COUNT(*) FILTER (WHERE in_stock = false) as oos_count
FROM products
WHERE brand_id = 'your-brand-id';
```

**Fix:** Run stock sync from Shopify or manually update `in_stock` values.

---

### Issue: Luna still offering OOS products

**Check:**
1. System prompt includes availability rules?
2. Products correctly separated in prompt?
3. Metadata tracking only in-stock products?

**Debug:**
```javascript
console.log('In-stock:', inStockProducts.length);
console.log('OOS:', outOfStockProducts.length);
```

---

### Issue: Customers confused about availability

**Solutions:**
- Review Luna's response tone
- Add clearer availability indicators
- Provide estimated restock dates (if known)
- Offer waitlist/notification signup

---

## Future Enhancements

- [ ] Estimated restock dates for OOS products
- [ ] "Notify me when available" feature
- [ ] Pre-order capability for upcoming products
- [ ] Stock level indicators (e.g., "Only 2 left!")
- [ ] Inventory alerts for low-stock items
- [ ] Historical stock data analytics
- [ ] Automatic alternative suggestions based on similarity

---

## Summary

✅ **Fetches all products** - Both in-stock and out-of-stock
✅ **Clear separation** - Visual indicators (✅/❌)
✅ **Honest AI responses** - Never lies about availability
✅ **Alternative suggestions** - Helps customers find substitutes
✅ **Order protection** - Prevents OOS orders
✅ **Tested & verified** - Test script confirms behavior

Luna now handles product availability intelligently, maintaining customer trust while maximizing sales opportunities! 🎯
