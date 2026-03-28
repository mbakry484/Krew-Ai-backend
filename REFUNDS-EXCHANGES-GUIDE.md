# Refunds & Exchanges System Guide

## Overview
Complete refund and exchange management system integrated with your Luna AI chatbot. When customers request refunds or exchanges, Luna automatically escalates and creates tracking records.

---

## 🗄️ Database Setup

### Step 1: Run SQL Schema in Supabase

Copy and paste the contents of `add-refunds-exchanges-schema.sql` into your Supabase SQL Editor and run it.

**Quick Link to SQL File:** `add-refunds-exchanges-schema.sql`

This creates:
- ✅ `exchanges` table with full tracking
- ✅ `refunds` table with full tracking
- ✅ Database views (`pending_exchanges`, `pending_refunds`)
- ✅ Indexes for performance
- ✅ Auto-update triggers
- ✅ Row-level security policies

### Step 2: Verify Tables Created

Run this query to verify:

```sql
-- Check if tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('exchanges', 'refunds');

-- Should return 2 rows
```

---

## 🔌 How It Works (Chatbot Integration)

### Automatic Flow:

1. **Customer:** "I want a refund" or "I need to exchange this"
2. **Luna AI:** Collects information (order number, reason, photos)
3. **Luna AI:** Says `ESCALATE_REFUND` or `ESCALATE_EXCHANGE` in response
4. **System automatically:**
   - Marks conversation as escalated
   - Creates refund/exchange record in database
   - Stops AI from responding (human team takes over)
   - Logs all details for team review

### Escalation Types:

| Type | Trigger | What Happens |
|------|---------|--------------|
| **Refund** | Customer wants money back | Creates `refunds` table entry |
| **Exchange** | Customer wants different size/item | Creates `exchanges` table entry |
| **Delivery** | Order delayed 7+ days | Escalates conversation only |
| **General** | Off-topic (jobs, etc.) | Escalates conversation only |

---

## 📡 API Endpoints

### Refunds API

#### List All Refunds
```http
GET /refunds?brand_id=YOUR_BRAND_ID&status=pending&limit=50
```

**Response:**
```json
{
  "refunds": [
    {
      "id": "uuid",
      "customer_name": "Ahmed Hassan",
      "product_name": "Black Dress",
      "refund_amount": 500.00,
      "refund_reason": "defective",
      "status": "pending",
      "created_at": "2025-01-15T10:30:00Z"
    }
  ],
  "count": 1
}
```

#### Get Pending Refunds (Using View)
```http
GET /refunds/pending?brand_id=YOUR_BRAND_ID
```

#### Get Single Refund
```http
GET /refunds/:refund_id
```

#### Create Refund (Manual)
```http
POST /refunds
Content-Type: application/json

{
  "brand_id": "uuid",
  "customer_id": "instagram_user_id",
  "customer_name": "Ahmed Hassan",
  "customer_phone": "+201234567890",
  "product_name": "Black Dress",
  "order_amount": 500.00,
  "refund_amount": 500.00,
  "refund_reason": "defective",
  "refund_reason_details": "Zipper broken on arrival"
}
```

#### Approve Refund
```http
POST /refunds/:refund_id/approve

{
  "approved_by": "Sara (Team Lead)",
  "notes": "Approved - sending full refund",
  "refund_amount": 500.00
}
```

#### Reject Refund
```http
POST /refunds/:refund_id/reject

{
  "rejected_by": "Sara (Team Lead)",
  "reason": "Outside 7-day return window"
}
```

#### Mark Refund Complete
```http
POST /refunds/:refund_id/complete

{
  "transaction_id": "TXN123456",
  "refund_method": "bank_transfer",
  "completed_by": "Finance Team",
  "notes": "Refund processed successfully"
}
```

#### Get Refund Statistics
```http
GET /refunds/stats/summary?brand_id=YOUR_BRAND_ID
```

**Response:**
```json
{
  "total": 45,
  "by_status": {
    "pending": 12,
    "approved": 8,
    "completed": 20,
    "rejected": 5
  },
  "by_reason": {
    "defective": 15,
    "damaged": 10,
    "not_as_described": 8,
    "delivery_issue": 7,
    "other": 5
  },
  "total_amount": 22500.00
}
```

---

### Exchanges API

#### List All Exchanges
```http
GET /exchanges?brand_id=YOUR_BRAND_ID&status=pending&limit=50
```

#### Get Pending Exchanges
```http
GET /exchanges/pending?brand_id=YOUR_BRAND_ID
```

#### Get Single Exchange
```http
GET /exchanges/:exchange_id
```

#### Create Exchange (Manual)
```http
POST /exchanges

{
  "brand_id": "uuid",
  "customer_id": "instagram_user_id",
  "customer_name": "Fatima Ali",
  "customer_phone": "+201234567890",
  "customer_address": "123 Main St, Cairo",
  "original_product_name": "Blue Jeans",
  "original_size": "M",
  "requested_size": "L",
  "exchange_reason": "size_issue",
  "exchange_reason_details": "Too small"
}
```

#### Approve Exchange
```http
POST /exchanges/:exchange_id/approve

{
  "approved_by": "Sara (Team Lead)",
  "notes": "Large size in stock",
  "requested_size": "L"
}
```

#### Reject Exchange
```http
POST /exchanges/:exchange_id/reject

{
  "rejected_by": "Sara (Team Lead)",
  "reason": "Requested size out of stock"
}
```

#### Mark Exchange Shipped
```http
POST /exchanges/:exchange_id/ship

{
  "tracking_number": "TRACK123456",
  "shipped_by": "Warehouse Team",
  "notes": "Sent via Aramex"
}
```

#### Mark Exchange Complete
```http
POST /exchanges/:exchange_id/complete

{
  "completed_by": "Customer Service",
  "notes": "Customer confirmed receipt"
}
```

#### Get Exchange Statistics
```http
GET /exchanges/stats/summary?brand_id=YOUR_BRAND_ID
```

---

## 📊 SQL Queries for Your Dashboard

### Pending Refunds Needing Action
```sql
SELECT
  r.id,
  r.customer_name,
  r.customer_phone,
  r.product_name,
  r.refund_amount,
  r.refund_reason,
  r.created_at,
  COUNT(m.id) as message_count
FROM refunds r
LEFT JOIN conversations c ON r.conversation_id = c.id
LEFT JOIN messages m ON c.id = m.conversation_id
WHERE r.brand_id = 'YOUR_BRAND_ID'
  AND r.status = 'pending'
GROUP BY r.id
ORDER BY r.created_at DESC
LIMIT 20;
```

### Pending Exchanges Needing Action
```sql
SELECT
  e.id,
  e.customer_name,
  e.customer_phone,
  e.original_product_name,
  e.original_size,
  e.requested_size,
  e.exchange_reason,
  e.created_at
FROM exchanges e
WHERE e.brand_id = 'YOUR_BRAND_ID'
  AND e.status = 'pending'
ORDER BY e.created_at DESC
LIMIT 20;
```

### Refund Analytics (Last 30 Days)
```sql
SELECT
  refund_reason,
  COUNT(*) as count,
  SUM(refund_amount) as total_amount,
  AVG(refund_amount) as avg_amount,
  COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
  COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_count
FROM refunds
WHERE brand_id = 'YOUR_BRAND_ID'
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY refund_reason
ORDER BY count DESC;
```

### Exchange Analytics (Last 30 Days)
```sql
SELECT
  exchange_reason,
  COUNT(*) as count,
  COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
  COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_count
FROM exchanges
WHERE brand_id = 'YOUR_BRAND_ID'
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY exchange_reason
ORDER BY count DESC;
```

### Escalations Summary (All Types)
```sql
SELECT
  escalation_type,
  COUNT(*) as count,
  COUNT(CASE WHEN is_escalated = true THEN 1 END) as still_escalated
FROM conversations
WHERE brand_id = 'YOUR_BRAND_ID'
  AND escalation_type IS NOT NULL
GROUP BY escalation_type
ORDER BY count DESC;
```

### Customer Refund History
```sql
SELECT
  customer_id,
  customer_name,
  COUNT(*) as total_refunds,
  SUM(refund_amount) as total_refunded,
  MAX(created_at) as last_refund_date
FROM refunds
WHERE brand_id = 'YOUR_BRAND_ID'
GROUP BY customer_id, customer_name
HAVING COUNT(*) > 1
ORDER BY total_refunds DESC;
```

### Average Resolution Time
```sql
SELECT
  'refunds' as type,
  AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) as avg_hours
FROM refunds
WHERE brand_id = 'YOUR_BRAND_ID'
  AND resolved_at IS NOT NULL

UNION ALL

SELECT
  'exchanges' as type,
  AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) as avg_hours
FROM exchanges
WHERE brand_id = 'YOUR_BRAND_ID'
  AND resolved_at IS NOT NULL;
```

---

## 🚀 Quick Start Guide

### For Your Team:

1. **Run the SQL schema** in Supabase
2. **Restart your backend** server
3. **Test with Instagram** - send "I want a refund"
4. **Check database** - refund record auto-created
5. **Use API endpoints** to manage refunds/exchanges

### Testing Refund Flow:

```
Customer: "I received a damaged dress, I want a refund"
Luna: "Sorry to hear that! Could you share your order number
       and photos of the damage? Our team will review your
       refund request."
Customer: *sends photos*
Luna: "Thank you! The team will review your refund request
       and get back to you as soon as possible. ESCALATE_REFUND"
```

System automatically:
- Creates refund record in database ✅
- Stops AI responses ✅
- Team can view via: `GET /refunds/pending?brand_id=xxx`

### Testing Exchange Flow:

```
Customer: "This dress is too small, can I exchange for a larger size?"
Luna: "Of course! What size would you like instead?"
Customer: "Size L please"
Luna: "Got it! Let me check with the team. ESCALATE_EXCHANGE"
```

System automatically:
- Creates exchange record in database ✅
- Stops AI responses ✅
- Team can view via: `GET /exchanges/pending?brand_id=xxx`

---

## 📋 Status Workflows

### Refund Status Flow:
```
pending → approved → processed → completed
         ↓
      rejected → closed
```

### Exchange Status Flow:
```
pending → approved → shipped → completed
         ↓
      rejected → closed
```

---

## 🔐 Security Notes

- All tables have Row Level Security (RLS) enabled
- Service role has full access (your backend)
- Customer data is only accessible via authenticated API calls
- Sensitive payment info should be encrypted at application level

---

## 💡 Best Practices

1. **Always collect evidence:** Ask for photos for defective/damaged items
2. **Set clear policies:** Define refund window (e.g., 7 days)
3. **Track resolution time:** Monitor `resolved_at - created_at`
4. **Use internal notes:** Document all team decisions
5. **Update customers:** Send updates when status changes

---

## 🆘 Troubleshooting

### Issue: Refund not auto-created
**Check:**
- Luna response contains `ESCALATE_REFUND`
- Backend logs show "Auto-created refund record"
- `refunds` table exists in Supabase

### Issue: API returns 404
**Check:**
- Routes registered in `server.js`
- Server restarted after adding routes
- Correct endpoint URL (e.g., `/refunds` not `/refund`)

### Issue: Permission denied
**Check:**
- RLS policies created correctly
- Using service role key (not anon key)
- `brand_id` matches your actual brand ID

---

## 📞 Support

If you encounter issues:
1. Check backend logs: `console.log` output
2. Check Supabase logs: SQL errors
3. Test with Postman/Insomnia first
4. Verify SQL schema ran successfully

---

## ✅ Implementation Checklist

- [ ] Run `add-refunds-exchanges-schema.sql` in Supabase
- [ ] Verify tables created (`exchanges`, `refunds`)
- [ ] Routes registered in `server.js`
- [ ] Backend server restarted
- [ ] Test refund flow with Instagram
- [ ] Test exchange flow with Instagram
- [ ] Test API endpoints with Postman
- [ ] Set up dashboard to view pending items
- [ ] Train team on using API endpoints

---

**System Status:** ✅ Fully Implemented & Ready to Use
**Last Updated:** 2025-01-15
