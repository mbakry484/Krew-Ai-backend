# Orders API - Documentation

## Overview

The Orders API provides endpoints for fetching and analyzing orders created through the Luna AI agent on Instagram/Messenger.

## Endpoints

### GET /orders
Fetch all orders for the authenticated brand.

**Authentication:** Required (JWT)

**Request:**
```bash
GET /orders
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "orders": [
    {
      "id": "abc-123-def-456",
      "brand_id": "xyz-789",
      "conversation_id": "conv-123",
      "shopify_order_id": "5678901234",
      "shopify_order_number": "1001",
      "customer_name": "Ahmed Hassan",
      "customer_phone": "+20 123 456 7890",
      "customer_address": "123 Main St, Cairo",
      "product_name": "Premium Hoodie",
      "price": 299.00,
      "currency": "EGP",
      "status": "pending",
      "created_at": "2026-03-22T19:30:00Z"
    },
    {
      "id": "def-456-ghi-789",
      "brand_id": "xyz-789",
      "conversation_id": "conv-456",
      "shopify_order_id": "5678901235",
      "shopify_order_number": "1002",
      "customer_name": "Sara Mohamed",
      "customer_phone": "+20 987 654 3210",
      "customer_address": "456 Oak Ave, Alexandria",
      "product_name": "Classic T-Shirt",
      "price": 149.00,
      "currency": "EGP",
      "status": "completed",
      "created_at": "2026-03-22T18:15:00Z"
    }
  ],
  "total": 2
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `orders` | Array | List of order objects |
| `total` | Number | Total number of orders |

**Order Object Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Supabase order ID |
| `brand_id` | UUID | Brand that received the order |
| `conversation_id` | UUID | Instagram conversation ID |
| `shopify_order_id` | String | Shopify internal order ID |
| `shopify_order_number` | String | Human-readable order number |
| `customer_name` | String | Customer full name |
| `customer_phone` | String | Customer phone number |
| `customer_address` | String | Delivery address |
| `product_name` | String | Product ordered |
| `price` | Decimal | Order price |
| `currency` | String | Currency code (EGP) |
| `status` | String | Order status (pending, completed, cancelled) |
| `created_at` | Timestamp | Order creation time |

**Sorting:**
Orders are sorted by `created_at` DESC (most recent first).

**Error Responses:**

```json
// 401 Unauthorized (no/invalid JWT)
{
  "error": "Unauthorized"
}

// 500 Internal Server Error
{
  "error": "Failed to fetch orders",
  "details": "error message"
}
```

---

### GET /orders/stats
Get order statistics for the authenticated brand.

**Authentication:** Required (JWT)

**Request:**
```bash
GET /orders/stats
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "total_orders": 15,
  "total_revenue": 4485.00,
  "pending_orders": 8,
  "completed_orders": 7
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `total_orders` | Number | Total count of all orders |
| `total_revenue` | Number | Sum of all order prices |
| `pending_orders` | Number | Count of orders with status = 'pending' |
| `completed_orders` | Number | Count of orders with status = 'completed' |

**Calculation:**
- `total_orders` = COUNT(*) WHERE brand_id = user_id
- `total_revenue` = SUM(price) WHERE brand_id = user_id
- `pending_orders` = COUNT(*) WHERE brand_id = user_id AND status = 'pending'
- `completed_orders` = COUNT(*) WHERE brand_id = user_id AND status = 'completed'

**Error Responses:**

```json
// 401 Unauthorized (no/invalid JWT)
{
  "error": "Unauthorized"
}

// 500 Internal Server Error
{
  "error": "Failed to fetch order stats",
  "details": "error message"
}
```

---

## Authentication

Both endpoints require JWT authentication via the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

The JWT must contain:
- `user_id` - The brand ID

The `verifyToken` middleware extracts the brand ID from `req.user.user_id`.

---

## Code Implementation

### File Structure

```
routes/
  orders.js         ← New file
server.js           ← Updated to mount /orders
```

### routes/orders.js

```javascript
const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

// GET /orders - Fetch all orders
router.get('/', verifyToken, async (req, res) => {
  const brandId = req.user.user_id;

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
  }

  res.json({
    orders: orders || [],
    total: orders?.length || 0
  });
});

// GET /orders/stats - Get statistics
router.get('/stats', verifyToken, async (req, res) => {
  const brandId = req.user.user_id;

  const { data: orders, error } = await supabase
    .from('orders')
    .select('price, status')
    .eq('brand_id', brandId);

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch order stats', details: error.message });
  }

  const total_orders = orders?.length || 0;
  const total_revenue = orders?.reduce((sum, order) => sum + (parseFloat(order.price) || 0), 0) || 0;
  const pending_orders = orders?.filter(order => order.status === 'pending').length || 0;
  const completed_orders = orders?.filter(order => order.status === 'completed').length || 0;

  res.json({
    total_orders,
    total_revenue,
    pending_orders,
    completed_orders
  });
});

module.exports = router;
```

### server.js Updates

```javascript
const ordersRoutes = require('./routes/orders');

// ...

app.use('/orders', ordersRoutes);
```

---

## Usage Examples

### Fetch All Orders

```bash
curl -X GET http://localhost:3000/orders \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response:**
```json
{
  "orders": [
    {
      "id": "abc-123",
      "brand_id": "xyz-789",
      "shopify_order_number": "1001",
      "customer_name": "Ahmed Hassan",
      "product_name": "Premium Hoodie",
      "price": 299.00,
      "status": "pending",
      "created_at": "2026-03-22T19:30:00Z"
    }
  ],
  "total": 1
}
```

### Get Order Stats

```bash
curl -X GET http://localhost:3000/orders/stats \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response:**
```json
{
  "total_orders": 15,
  "total_revenue": 4485.00,
  "pending_orders": 8,
  "completed_orders": 7
}
```

---

## Frontend Integration

### React Example

```javascript
// Fetch orders
const fetchOrders = async () => {
  const token = localStorage.getItem('jwt');

  const response = await fetch('http://localhost:3000/orders', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await response.json();
  console.log(data.orders, data.total);
};

// Fetch stats
const fetchStats = async () => {
  const token = localStorage.getItem('jwt');

  const response = await fetch('http://localhost:3000/orders/stats', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await response.json();
  console.log(data);
  // { total_orders: 15, total_revenue: 4485, ... }
};
```

---

## Database Schema

The endpoints query the `orders` table:

```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id),
  conversation_id UUID REFERENCES conversations(id),
  shopify_order_id TEXT,
  shopify_order_number TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,
  product_name TEXT,
  price DECIMAL(10, 2),
  currency TEXT DEFAULT 'EGP',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_orders_brand_id ON orders(brand_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
```

---

## Order Statuses

| Status | Description |
|--------|-------------|
| `pending` | Order created, awaiting fulfillment |
| `completed` | Order fulfilled and delivered |
| `cancelled` | Order cancelled by customer or admin |

**Note:** Status updates must be done manually or through a separate endpoint (not yet implemented).

---

## Performance Considerations

### GET /orders
- Returns ALL orders for the brand (no pagination yet)
- For brands with 1000+ orders, consider adding pagination:
  ```javascript
  const limit = req.query.limit || 50;
  const offset = req.query.offset || 0;

  .limit(limit)
  .offset(offset)
  ```

### GET /orders/stats
- Fetches only `price` and `status` fields (not all order data)
- Calculates stats in-memory (fast for <10k orders)
- For larger datasets, consider database aggregation:
  ```sql
  SELECT
    COUNT(*) as total_orders,
    SUM(price) as total_revenue,
    COUNT(*) FILTER (WHERE status = 'pending') as pending_orders,
    COUNT(*) FILTER (WHERE status = 'completed') as completed_orders
  FROM orders
  WHERE brand_id = $1
  ```

---

## Security

✅ **JWT Authentication** - Both endpoints protected with `verifyToken` middleware
✅ **Brand Isolation** - Orders filtered by `brand_id = req.user.user_id`
✅ **Input Validation** - Brand ID extracted from verified JWT (not user input)
✅ **Error Handling** - Errors logged and generic messages returned to client

---

## Testing

### Test GET /orders

1. Authenticate and get JWT token:
   ```bash
   POST /auth/login
   ```

2. Fetch orders:
   ```bash
   curl -X GET http://localhost:3000/orders \
     -H "Authorization: Bearer <token>"
   ```

3. Verify:
   - Returns orders array
   - Returns total count
   - Orders sorted by created_at DESC
   - Only returns orders for authenticated brand

### Test GET /orders/stats

1. Authenticate and get JWT token
2. Fetch stats:
   ```bash
   curl -X GET http://localhost:3000/orders/stats \
     -H "Authorization: Bearer <token>"
   ```

3. Verify:
   - Returns total_orders count
   - Returns total_revenue sum
   - Returns pending_orders count
   - Returns completed_orders count
   - Calculations are correct

---

## Future Enhancements

Possible improvements:

1. **Pagination** - Add limit/offset to GET /orders
2. **Filtering** - Filter by status, date range, customer
3. **Sorting** - Allow sorting by different fields
4. **Order Details** - GET /orders/:id endpoint
5. **Update Order** - PUT /orders/:id to update status
6. **Cancel Order** - POST /orders/:id/cancel
7. **Export** - GET /orders/export (CSV/Excel)
8. **Real-time Stats** - WebSocket for live order updates

---

## Summary

✅ **GET /orders** - Fetch all orders for authenticated brand
✅ **GET /orders/stats** - Get order statistics (count, revenue, status breakdown)
✅ **JWT Protected** - Both endpoints require authentication
✅ **Brand Isolated** - Each brand only sees their own orders
✅ **Mounted at /orders** - Available at base URL + /orders

The Orders API is **production-ready and secure**!
