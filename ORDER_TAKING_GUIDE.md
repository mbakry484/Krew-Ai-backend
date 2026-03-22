# Order Taking Feature - Implementation Guide

This guide explains how the AI-powered order taking system works in the Krew AI Backend.

## Overview

Luna (the AI assistant) can now take orders through Instagram DMs with persistent memory, tracking the conversation state across multiple messages and automatically creating Shopify orders when ready.

## Architecture

### 1. Conversation Metadata Structure

Each conversation stores metadata in the `conversations.metadata` JSON field:

```javascript
{
  discussed_products: [
    {
      index: 1,
      name: "Product Name",
      product_id: "uuid",
      variant_id: "shopify_variant_id",
      price: 299.99
    }
  ],
  current_order: {
    product_name: "Product Name",
    product_id: "uuid",
    variant_id: "shopify_variant_id",
    price: 299.99
  },
  collected_info: {
    name: "John Doe",
    phone: "+1234567890",
    address: "123 Main St, City"
  },
  awaiting: "name" | "phone" | "address" | "confirmation" | null
}
```

### 2. Order Flow

#### Step 1: Product Discussion
- When Luna mentions products in replies, they're automatically added to `discussed_products`
- Each product gets an index number for easy reference
- Customer can say "I want the first one" instead of repeating the product name

#### Step 2: Order Intent Detection
- System detects keywords like: "order", "buy", "purchase", "3ayez", "عايز"
- Identifies which product the customer wants to order
- Sets `current_order` in metadata

#### Step 3: Information Collection
- Luna asks for name, phone, and address **one at a time**
- System tracks what's been collected in `collected_info`
- Updates `awaiting` to indicate what info is currently being requested
- Prevents asking for already-collected information

#### Step 4: Order Confirmation
- Once all info is collected, Luna shows an order summary
- Asks customer to confirm
- Sets `awaiting: "confirmation"`

#### Step 5: Order Creation
- When customer confirms, Luna replies with `ORDER_READY`
- System detects this trigger word
- Creates order in Shopify via Admin API
- Saves order to `orders` table in Supabase
- Replaces `ORDER_READY` with confirmation message
- Resets order state in metadata

## Key Files

### `routes/instagram.js`
Main webhook handler with order logic:
- `handleIncomingMessage()` - Main message handler
- `updateMetadataFromConversation()` - Tracks order state
- `extractProductMentions()` - Identifies discussed products
- `detectAwaitingState()` - Determines what info Luna is asking for
- `detectOrderIntent()` - Checks if customer wants to order
- `identifyOrderedProduct()` - Matches customer intent to specific product
- `handleOrderCreation()` - Creates Shopify order and saves to DB

### `lib/claude.js`
AI prompt generation with order context:
- `generateReply()` - Generates AI response with conversation context
- `buildSystemPrompt()` - Builds system prompt including current order state

### `lib/shopify.js`
Shopify integration:
- `createShopifyOrder()` - Creates order via Shopify Admin API

## Database Schema

### Conversations Table
```sql
ALTER TABLE conversations
ADD COLUMN metadata JSONB DEFAULT '{
  "discussed_products": [],
  "current_order": null,
  "collected_info": {"name": null, "phone": null, "address": null},
  "awaiting": null
}'::jsonb;
```

### Orders Table
```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id),
  shopify_order_id TEXT,
  order_number TEXT,
  product_name TEXT NOT NULL,
  product_id UUID,
  variant_id TEXT,
  price DECIMAL(10, 2),
  currency TEXT DEFAULT 'EGP',
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Setup Instructions

### 1. Database Migration
Run the SQL migration to add required tables and columns:
```bash
# Run in Supabase SQL Editor
psql < add-order-tracking.sql
```

### 2. Environment Variables
Ensure these are set:
```env
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://...
SUPABASE_SERVICE_KEY=...
```

### 3. Shopify Integration
Ensure the brand has a Shopify integration in the `integrations` table:
```sql
INSERT INTO integrations (brand_id, platform, shopify_shop_domain, access_token)
VALUES ('brand-uuid', 'shopify', 'mystore.myshopify.com', 'shpat_...');
```

## Testing the Order Flow

### Example Conversation:

**Customer:** "Hi, what products do you have?"

**Luna:** "Hello! We have:
1. Premium Hoodie - 299 EGP
2. Classic T-Shirt - 149 EGP

Which one interests you?"

*(System adds both products to `discussed_products`)*

---

**Customer:** "I want to order the first one"

**Luna:** "Great choice! The Premium Hoodie for 299 EGP. To complete your order, what's your full name?"

*(System sets `current_order`, sets `awaiting: "name"`)*

---

**Customer:** "Ahmed Hassan"

**Luna:** "Thanks Ahmed! What's your phone number?"

*(System saves name, sets `awaiting: "phone"`)*

---

**Customer:** "+20 123 456 7890"

**Luna:** "Perfect! And what's your delivery address?"

*(System saves phone, sets `awaiting: "address"`)*

---

**Customer:** "123 Main St, Cairo"

**Luna:** "✅ Order Summary:
• Product: Premium Hoodie
• Price: 299 EGP
• Name: Ahmed Hassan
• Phone: +20 123 456 7890
• Address: 123 Main St, Cairo

Can you confirm this order?"

*(System saves address, sets `awaiting: "confirmation"`)*

---

**Customer:** "Yes, confirmed"

**Luna:** "ORDER_READY"

*(System creates Shopify order, saves to database, replaces ORDER_READY with confirmation message)*

**Luna:** "✅ Your order has been placed! Order #1234

Premium Hoodie — 299 EGP
Delivering to: 123 Main St, Cairo

We'll contact you on +20 123 456 7890 to confirm. Thank you! 🎉"

*(System resets `current_order`, `collected_info`, and `awaiting`)*

## Error Handling

### No Shopify Integration
If brand doesn't have Shopify integration, order is recorded in database only:
```
"✅ Your order details have been recorded! Our team will contact you shortly to complete the order."
```

### Missing Information
If customer confirms before all info is collected:
```
"⚠️ We need a bit more information to complete your order. Please provide your full details."
```

### Shopify API Error
If Shopify order creation fails:
```
"⚠️ There was an issue creating your order. Our team has been notified and will contact you shortly."
```

## Multi-Language Support

The system supports:
- **English**: "I want to order", "buy", "purchase"
- **Arabic**: "بدي", "عايز", "اشتري", "خد"
- **Franco Arabic**: "3ayez", "3ayz", "awel" (first)

Luna automatically detects and replies in the customer's language.

## Customization

### Adjusting Order Flow
Edit the system prompt in `lib/claude.js` → `buildSystemPrompt()` to change:
- Order confirmation message format
- Information collection sequence
- Luna's tone and behavior

### Adding Product Variants
Update `identifyOrderedProduct()` in `routes/instagram.js` to handle:
- Size selection (S, M, L, XL)
- Color selection
- Quantity selection

### Custom Order Status
Modify the `orders.status` field to add custom statuses:
- `pending` → `processing` → `shipped` → `delivered`
- Add `cancelled`, `refunded`, etc.

## Monitoring

### Check Order State
```sql
-- View conversation metadata
SELECT id, customer_id, metadata
FROM conversations
WHERE brand_id = 'brand-uuid';

-- View recent orders
SELECT * FROM orders
WHERE brand_id = 'brand-uuid'
ORDER BY created_at DESC
LIMIT 10;
```

### Logs
The system logs detailed information at each step:
- `📊 Loading conversation metadata...`
- `🛒 Current order set:...`
- `📝 Captured name:...`
- `📱 Captured phone:...`
- `📍 Captured address:...`
- `🎉 ORDER_READY detected!`
- `✅ Order saved to database`

## Troubleshooting

### Luna Not Detecting Orders
- Check if order keywords are present: "order", "buy", "3ayez"
- Verify products are in `discussed_products` metadata
- Check console logs for `detectOrderIntent()` results

### Metadata Not Saving
- Verify `metadata` column exists in `conversations` table
- Check for JSONB syntax errors in metadata structure
- Review console logs for database errors

### Shopify Orders Not Creating
- Verify Shopify integration exists with valid `access_token`
- Check `shopify_shop_domain` format (e.g., `store.myshopify.com`)
- Ensure products have valid `variant_id` (Shopify variant ID)
- Review Shopify API error messages in logs

## Future Enhancements

Potential improvements:
1. **Payment Integration**: Add payment link collection before ORDER_READY
2. **Order Tracking**: Send automatic updates when order status changes
3. **Product Variants**: Support size/color selection in conversation
4. **Quantity Selection**: Allow ordering multiple items
5. **Cart System**: Support ordering multiple different products
6. **Order History**: Let customers view their past orders
7. **Order Cancellation**: Allow customers to cancel pending orders
8. **Discount Codes**: Support promo code validation during checkout

## License

Part of Krew AI Backend - Instagram DM Assistant with Order Taking
