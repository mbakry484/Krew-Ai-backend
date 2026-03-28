# SQL Queries to Run in Supabase

## 🚀 Quick Setup - Copy & Paste These in Order

---

## Step 1: Run Escalation Schema (If Not Done Already)

Open the file: **`add-escalation-schema.sql`**

Copy its entire contents and paste into Supabase SQL Editor, then click **RUN**.

This adds:
- `is_escalated` column to conversations
- `escalation_type` column
- `escalation_reason` column
- `escalated_at` timestamp
- `escalated_by` field

---

## Step 2: Run Refunds & Exchanges Schema

Open the file: **`add-refunds-exchanges-schema.sql`**

Copy its entire contents and paste into Supabase SQL Editor, then click **RUN**.

This creates:
- `exchanges` table
- `refunds` table
- Database views (`pending_exchanges`, `pending_refunds`)
- Indexes for performance
- Auto-update triggers

---

## Step 3: Verify Installation

Run this query to confirm everything is set up:

```sql
-- Verify all tables exist
SELECT
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
AND table_name IN ('conversations', 'exchanges', 'refunds', 'orders')
ORDER BY table_name;
```

**Expected Result:** Should show 4 tables

---

## Step 4: Check Escalation Columns Added

```sql
-- Verify escalation columns exist in conversations table
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'conversations'
AND column_name IN ('is_escalated', 'escalation_type', 'escalation_reason', 'escalated_at');
```

**Expected Result:** Should show 4 rows

---

## Step 5: Verify Views Created

```sql
-- Check if views exist
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('pending_exchanges', 'pending_refunds', 'escalated_conversations');
```

**Expected Result:** Should show 3 views

---

## 🧪 Test Queries

### Test 1: Check for Pending Refunds
```sql
SELECT * FROM pending_refunds
LIMIT 5;
```

### Test 2: Check for Pending Exchanges
```sql
SELECT * FROM pending_exchanges
LIMIT 5;
```

### Test 3: Check for Escalated Conversations
```sql
SELECT * FROM escalated_conversations
LIMIT 5;
```

---

## ✅ Success Criteria

If all queries run without errors, you're ready to go! Your system now has:

- ✅ Escalation tracking for conversations
- ✅ Complete refund management system
- ✅ Complete exchange management system
- ✅ Auto-tracking when Luna escalates
- ✅ API endpoints ready to use

---

## 🔄 If You Need to Reset (Development Only)

**⚠️ WARNING: This deletes all data! Only use in development!**

```sql
-- Drop tables (cascades to dependent objects)
DROP TABLE IF EXISTS refunds CASCADE;
DROP TABLE IF EXISTS exchanges CASCADE;

-- Drop views
DROP VIEW IF EXISTS pending_refunds CASCADE;
DROP VIEW IF EXISTS pending_exchanges CASCADE;
DROP VIEW IF EXISTS escalated_conversations CASCADE;

-- Remove escalation columns from conversations
ALTER TABLE conversations
DROP COLUMN IF EXISTS is_escalated,
DROP COLUMN IF EXISTS escalation_type,
DROP COLUMN IF EXISTS escalation_reason,
DROP COLUMN IF EXISTS escalated_at,
DROP COLUMN IF EXISTS escalated_by;
```

Then re-run the schema files.

---

## 🎯 Next Steps After Running SQL

1. **Restart your backend server**
2. **Test with Instagram messages**:
   - Send: "I want a refund"
   - Luna should escalate and create refund record
3. **Check the API**:
   ```bash
   curl http://localhost:3000/refunds/pending?brand_id=YOUR_BRAND_ID
   ```
4. **Build your dashboard** using the API endpoints
5. **Train your team** on the new system

---

## 📚 Reference

- **Full Documentation:** See `REFUNDS-EXCHANGES-GUIDE.md`
- **Test Escalation:** Run `node test-escalation.js`
- **API Endpoints:**
  - `GET /refunds` - List refunds
  - `GET /exchanges` - List exchanges
  - `GET /escalations` - List escalated conversations
  - See guide for all endpoints

---

**System Ready!** 🎉
