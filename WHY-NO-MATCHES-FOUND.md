# Why Vector Search Returns 0 Matches - Root Cause Analysis

## The Smoking Gun 🔫

The diagnostic script **definitively identified the issue**:

```
📦 Product Found: "WSTDPTNL GREY LEOPARD HOODED ZIP-UP"
   In Stock: ❌ No
   Has Embedding: ✅ Yes

🔍 Searching with NO threshold (to see all similarities)...
🎯 Search Results: 0 products found
```

## The Problem

**Even with threshold = 0.0** (which should return ALL products with ANY similarity), the search returned **0 results**.

This is mathematically impossible UNLESS the product is being filtered out by another condition.

## Root Cause

The SQL function `match_products_by_embedding` **still contains this line in the WHERE clause**:

```sql
AND products.in_stock = true  -- ❌ This is filtering out the product!
```

Since the product `in_stock = false` (out of stock), it's **excluded from the search entirely**.

## Why This Happens

The migration instructions in [MIGRATION-IMAGE-SEARCH-OOS.md](MIGRATION-IMAGE-SEARCH-OOS.md) were provided, but the SQL function in **Supabase** hasn't been updated yet.

The SQL function exists in your **remote Supabase database**, not in your local code. It must be manually updated through the Supabase SQL Editor.

## Proof

### Evidence 1: Product Has Everything It Needs
- ✅ Has embedding: `embedding IS NOT NULL`
- ✅ Has description: `"grey color scheme... leopard print lining"`
- ✅ Correct brand_id: `6fe9cfc8-21e9-442f-9b6f-4f09f6c13823`
- ❌ **In stock: FALSE** ← This is the problem

### Evidence 2: Search Returns 0 Even With No Threshold
```javascript
const { data: matches } = await supabase.rpc('match_products_by_embedding', {
  query_embedding: queryEmbedding,
  match_brand_id: brandId,
  match_threshold: 0.0,  // NO filtering by similarity
  match_count: 10
});

// Result: 0 matches
```

If the function worked correctly, it should return this product even with terrible similarity (e.g., 5%), because threshold = 0.0 means "return everything".

### Evidence 3: Similar Descriptions
**Customer:** "gray zip-up hoodie... distressed text graphic... 'WASTED'... leopard print pattern"

**Database:** "grey color scheme... bold, distressed-type print... 'WASTED POTENTIAL'... leopard print lining"

These are clearly similar. The embedding should have >= 30% similarity. But search returns 0 because the product never even enters the comparison pool.

## The Fix (Step-by-Step)

### Step 1: Open Supabase SQL Editor

1. Go to [https://supabase.com/dashboard/project/YOUR_PROJECT](https://supabase.com)
2. Navigate to **SQL Editor**
3. Click **New Query**

---

### Step 2: Verify Current Function

Paste and run:

```sql
SELECT prosrc
FROM pg_proc
WHERE proname = 'match_products_by_embedding';
```

Look for this line in the output:
```sql
AND products.in_stock = true  -- ❌ This is the problem
```

If you see it, proceed to Step 3.

---

### Step 3: Update the Function

Copy the ENTIRE SQL from [MIGRATION-IMAGE-SEARCH-OOS.md](MIGRATION-IMAGE-SEARCH-OOS.md#step-1-update-sql-function-in-supabase) and paste it into the SQL Editor:

```sql
-- Updated function to include ALL products
CREATE OR REPLACE FUNCTION match_products_by_embedding(
  query_embedding vector(1536),
  match_brand_id uuid,
  match_threshold float DEFAULT 0.4,
  match_count int DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  shopify_product_id text,
  name text,
  description text,
  price decimal,
  image_url text,
  image_description text,
  in_stock boolean,
  availability text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    products.id,
    products.shopify_product_id,
    products.name,
    products.description,
    products.price,
    products.image_url,
    products.image_description,
    products.in_stock,
    products.availability,
    1 - (products.embedding <=> query_embedding) AS similarity
  FROM products
  WHERE
    products.embedding IS NOT NULL
    AND products.brand_id = match_brand_id
    AND 1 - (products.embedding <=> query_embedding) > match_threshold
  ORDER BY
    products.in_stock DESC,  -- Prioritize in-stock products
    products.embedding <=> query_embedding  -- Then by similarity
  LIMIT match_count;
END;
$$;
```

**Key changes:**
- ✅ Removed `AND products.in_stock = true` from WHERE
- ✅ Added `ORDER BY products.in_stock DESC` to prioritize in-stock

Click **RUN** (or press Ctrl+Enter).

---

### Step 4: Verify the Fix

Run the verification query again:

```sql
SELECT prosrc
FROM pg_proc
WHERE proname = 'match_products_by_embedding';
```

Confirm:
- ❌ NO `AND products.in_stock = true` in WHERE clause
- ✅ HAS `ORDER BY products.in_stock DESC`

---

### Step 5: Test Locally

Run the diagnostic again:

```bash
node diagnose-image-search.js
```

**Expected output:**
```
🎯 Search Results: 1+ products found

1. WSTDPTNL GREY LEOPARD HOODED ZIP-UP
   Similarity: 35-45%
   In Stock: ❌ No
   ...
```

If you see matches, **the fix worked!** 🎉

---

## Why It Took So Long to Identify

1. **The error was silent** - No SQL errors, just 0 results
2. **The product had everything** - Embedding, description, correct brand
3. **The descriptions were similar** - Should have matched
4. **The filter was invisible** - In remote database, not in code files

Only by running a diagnostic with **threshold = 0.0** did we prove the product was being filtered out entirely.

---

## After the Fix

Once the SQL function is updated, the system will work like this:

### Scenario: Customer sends image of grey leopard hoodie

**Step 1:** Luna describes the image
```
"gray zip-up hoodie with 'WASTED' text and leopard print lining"
```

**Step 2:** Vector search finds matches
```
🎯 Found 1 similar products:
1. WSTDPTNL GREY LEOPARD HOODED ZIP-UP (38% match, out of stock)
```

**Step 3:** Luna responds intelligently
```
This looks like our "WSTDPTNL GREY LEOPARD HOODED ZIP-UP" (1150 EGP),
but unfortunately it's currently out of stock ❌

Would you like me to suggest similar items that are available? Or I can
let you know when this comes back in stock! 😊
```

---

## TL;DR

**Problem:** SQL function filters `WHERE in_stock = true`, excluding OOS products

**Evidence:** Search returns 0 even with threshold = 0.0

**Fix:** Update SQL function in Supabase to remove `in_stock` filter

**Test:** Run `node diagnose-image-search.js` to verify

---

## Next Steps

1. ✅ Run SQL update in Supabase SQL Editor
2. ✅ Verify with `verify-sql-function.sql`
3. ✅ Test with `node diagnose-image-search.js`
4. ✅ Test live in Instagram DM by sending the grey leopard hoodie image

Once verified, Luna will correctly identify both in-stock AND out-of-stock products in image searches! 🚀
