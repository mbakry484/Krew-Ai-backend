# Migration: Update Image Search to Include Out-of-Stock Products

## Problem

Vector similarity search for customer images was **excluding out-of-stock products**, causing:
- ❌ No matches found even when exact product exists in database
- ❌ Customer frustration when they have the product image
- ❌ Missed opportunity to inform customers about restocking

## Solution

Update the `match_products_by_embedding` SQL function to:
- ✅ Include ALL products (in-stock and out-of-stock)
- ✅ Prioritize in-stock products in results
- ✅ Let Luna inform customers about stock status

## Migration Steps

### Step 1: Update SQL Function in Supabase

Run this SQL in **Supabase SQL Editor**:

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

### Step 2: Verify the Update

Test the function:

```sql
-- Check if function exists and returns all products
SELECT proname, prosrc
FROM pg_proc
WHERE proname = 'match_products_by_embedding';
```

### Step 3: Restart Your Application

After updating the SQL function:

```bash
# If using Docker/Render
# Your app will auto-restart

# If running locally
npm restart
```

## What Changed

### Before ❌

**SQL Filter:**
```sql
WHERE
  products.embedding IS NOT NULL
  AND products.brand_id = match_brand_id
  AND products.in_stock = true  -- ❌ Only in-stock
  AND 1 - (products.embedding <=> query_embedding) > match_threshold
ORDER BY products.embedding <=> query_embedding
```

**Result:**
- Out-of-stock products excluded
- Customer images not matched
- "No match found" even for exact products

---

### After ✅

**SQL Filter:**
```sql
WHERE
  products.embedding IS NOT NULL
  AND products.brand_id = match_brand_id
  -- Removed in_stock filter ✅
  AND 1 - (products.embedding <=> query_embedding) > match_threshold
ORDER BY
  products.in_stock DESC,  -- In-stock first
  products.embedding <=> query_embedding
```

**Result:**
- ALL products included
- In-stock products prioritized
- Luna tells customers about stock status

## Example Responses

### Scenario 1: Customer Sends Image of In-Stock Product

**Customer:** [Sends image of red hoodie]

**Luna:**
```
Yes! I found it! That looks like our "Red Hoodie" 😊

Price: 599 EGP
Availability: ✅ In stock and ready to ship!

Would you like to order this?
```

---

### Scenario 2: Customer Sends Image of Out-of-Stock Product

**Customer:** [Sends image of grey leopard hoodie]

**Luna:**
```
This looks like our "WSTDPTNL GREY LEOPARD HOODED ZIP-UP" (1150 EGP),
but unfortunately it's currently out of stock ❌

Would you like me to suggest similar items that are available? Or I can
let you know when this comes back in stock! 😊
```

---

### Scenario 3: Multiple Matches (Mixed Stock Status)

**Customer:** [Sends image of zip-up hoodie]

**Luna finds:**
1. Grey Leopard Hoodie - OUT OF STOCK (95% match)
2. Brown Leopard Hoodie - IN STOCK (92% match)

**Luna:**
```
I found something very similar! The "WSTDPTNL GREY LEOPARD HOODED ZIP-UP"
matches your image perfectly (1150 EGP), but it's currently out of stock.

However, we have the "WSTDPTNL BROWN LEOPARD HOODED ZIP-UP" in stock
(also 1150 EGP) with a very similar style! Would you like to see that?
```

## Testing

### Test 1: Out-of-Stock Product Image

```bash
# Send image of known OOS product via Instagram
# Expected: Luna identifies it, states it's OOS, offers alternatives
```

### Test 2: In-Stock Product Image

```bash
# Send image of known in-stock product
# Expected: Luna identifies it, confirms availability, offers to order
```

### Test 3: Check Database

```sql
-- Verify products have embeddings
SELECT
  name,
  in_stock,
  image_description IS NOT NULL as has_description,
  embedding IS NOT NULL as has_embedding
FROM products
WHERE brand_id = 'your-brand-id'
LIMIT 10;
```

## Rollback (If Needed)

If you need to revert to old behavior:

```sql
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
    AND products.in_stock = true  -- Old behavior
    AND 1 - (products.embedding <=> query_embedding) > match_threshold
  ORDER BY products.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

## Benefits

✅ **Better Customer Experience**
- Customers get answers even for OOS products
- Transparent communication about availability
- Opportunity to suggest alternatives

✅ **Sales Opportunities**
- Suggest similar in-stock products
- Capture interest for future restocks
- Build customer relationship

✅ **Accurate Information**
- No more "can't find this" when product exists
- Honest about stock status
- Maintains brand trust

## Monitoring

After migration, watch for:

1. **Match Rate Improvement**
   - Before: ~30% match rate
   - After: Should increase to ~60-70%

2. **Customer Responses**
   - Fewer "but I saw it on your website" complaints
   - More questions about restock dates

3. **Conversion**
   - Track alternative product acceptance rate
   - Monitor "notify when available" requests

---

**Migration Complete!** 🎯

Luna can now intelligently handle both in-stock and out-of-stock products in image search.
