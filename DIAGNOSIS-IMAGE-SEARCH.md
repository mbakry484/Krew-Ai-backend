# Image Search Diagnosis: Why 0 Matches Despite Similar Descriptions

## The Problem

Customer sent image of "WSTDPTNL GREY LEOPARD HOODED ZIP-UP" and got **0 matches** despite nearly identical descriptions existing in database.

**Customer Image Description:**
> "gray zip-up hoodie with a classic casual style. The hoodie has a prominent, distressed text graphic on the front that reads 'WASTED.' A distinctive feature is its interior, lined with a contrasting leopard print pattern"

**Database Description:**
> "hooded zip-up jacket featuring a grey color scheme. It has a bold, distressed-type print across the front reading 'WASTED POTENTIAL' and a distinctive leopard print lining on the hood"

**Similarity:** Extremely high (both mention grey, zip-up, hooded, leopard print lining, "WASTED" text)

## Most Likely Causes

### 1. SQL Migration Not Applied ✅ **ACTION REQUIRED**

The updated SQL function that removes the `in_stock = true` filter may not have been executed yet.

**How to Check:**
```sql
-- Run this in Supabase SQL Editor
SELECT prosrc
FROM pg_proc
WHERE proname = 'match_products_by_embedding';
```

**Look for:**
- ❌ OLD VERSION: Has `AND products.in_stock = true` in WHERE clause
- ✅ NEW VERSION: No `in_stock` filter, has `ORDER BY products.in_stock DESC`

**If OLD VERSION:**
Run the complete SQL from [MIGRATION-IMAGE-SEARCH-OOS.md](MIGRATION-IMAGE-SEARCH-OOS.md#step-1-update-sql-function-in-supabase)

---

### 2. Product Missing Embedding ✅ **ACTION REQUIRED**

The product might not have an embedding generated yet.

**How to Check:**
```sql
-- Check specific product
SELECT
  name,
  in_stock,
  image_description IS NOT NULL as has_description,
  embedding IS NOT NULL as has_embedding,
  image_url IS NOT NULL as has_image
FROM products
WHERE name LIKE '%GREY LEOPARD%'
  AND brand_id = '6fe9cfc8-21e9-442f-9b6f-4f09f6c13823';
```

**Expected Result:**
```
name                                     | in_stock | has_description | has_embedding | has_image
-----------------------------------------|----------|-----------------|---------------|----------
WSTDPTNL GREY LEOPARD HOODED ZIP-UP     | false    | true            | true          | true
```

**If `has_embedding = false`:**

The embedding was never generated. This is the most likely cause.

**Fix:**
```bash
# Trigger embedding generation for all products
POST http://localhost:3000/products/generate-embeddings
Authorization: Bearer YOUR_JWT_TOKEN
```

Or manually for this specific product:
```javascript
const { generateProductEmbedding } = require('./lib/embeddings');
const supabase = require('./lib/supabase');

// Get the product
const { data: product } = await supabase
  .from('products')
  .select('*')
  .eq('name', 'WSTDPTNL GREY LEOPARD HOODED ZIP-UP')
  .eq('brand_id', '6fe9cfc8-21e9-442f-9b6f-4f09f6c13823')
  .single();

// Generate embedding
await generateProductEmbedding(product);
console.log('✅ Embedding generated!');
```

---

### 3. Similarity Threshold Too High

Default threshold: **0.4** (40% similarity required)

Even with similar descriptions, embeddings might have cosine distance > 0.6 (meaning similarity < 0.4).

**Why this happens:**
- "WASTED" vs "WASTED POTENTIAL" - different tokens
- "classic casual style" vs no mention in DB description
- Small wording differences compound in embedding space

**How to Check:**
```sql
-- Temporarily disable threshold to see ALL similarities
CREATE OR REPLACE FUNCTION match_products_by_embedding(
  query_embedding vector(1536),
  match_brand_id uuid,
  match_threshold float DEFAULT 0.0,  -- Changed from 0.4
  match_count int DEFAULT 10  -- Increased from 3
)
-- ... rest stays same
```

Then test again. If matches appear, the threshold was too high.

**Fix:**
Lower threshold in [routes/instagram.js:66](routes/instagram.js#L66):
```javascript
const { data: matches, error } = await supabase.rpc('match_products_by_embedding', {
  query_embedding: queryEmbedding,
  match_brand_id: brandId,
  match_threshold: 0.3,  // Lowered from 0.4
  match_count: 3
});
```

---

### 4. pgvector Extension Not Enabled

Vector search won't work without the extension.

**How to Check:**
```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

**If empty:**
```sql
CREATE EXTENSION vector;
```

Then re-run [add-product-embeddings.sql](add-product-embeddings.sql).

---

### 5. HNSW Index Missing or Corrupt

Without the index, searches might fail silently.

**How to Check:**
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'products'
  AND indexname = 'idx_products_embedding';
```

**If missing:**
```sql
CREATE INDEX idx_products_embedding
ON products
USING hnsw (embedding vector_cosine_ops);
```

**If exists but searches still fail:**
```sql
-- Rebuild index
DROP INDEX idx_products_embedding;
CREATE INDEX idx_products_embedding
ON products
USING hnsw (embedding vector_cosine_ops);
```

---

### 6. Brand ID Mismatch

Vector search filters by `brand_id`. If mismatch, 0 results.

**How to Check:**
```sql
-- What brand_id is Luna using?
SELECT brand_id
FROM integrations
WHERE page_id = 'YOUR_INSTAGRAM_PAGE_ID';

-- Does the product have that brand_id?
SELECT brand_id, name
FROM products
WHERE name LIKE '%GREY LEOPARD%';
```

**If different:**
Update product's brand_id or fix integration mapping.

---

## Diagnostic Script

Create `diagnose-image-search.js`:

```javascript
require('dotenv').config();
const supabase = require('./lib/supabase');
const { generateEmbedding } = require('./lib/embeddings');

async function diagnose() {
  console.log('🔍 Image Search Diagnostic\n');

  // 1. Check if function exists
  const { data: funcCheck } = await supabase.rpc('match_products_by_embedding', {
    query_embedding: Array(1536).fill(0),
    match_brand_id: '6fe9cfc8-21e9-442f-9b6f-4f09f6c13823',
    match_threshold: 0,
    match_count: 1
  });

  if (!funcCheck) {
    console.log('❌ match_products_by_embedding function not found or errored');
    return;
  }
  console.log('✅ Function exists\n');

  // 2. Check product embeddings
  const { data: products } = await supabase
    .from('products')
    .select('name, in_stock, image_description, embedding')
    .eq('brand_id', '6fe9cfc8-21e9-442f-9b6f-4f09f6c13823')
    .like('name', '%GREY LEOPARD%');

  if (!products || products.length === 0) {
    console.log('❌ Product not found');
    return;
  }

  const product = products[0];
  console.log(`📦 Product: ${product.name}`);
  console.log(`   In Stock: ${product.in_stock}`);
  console.log(`   Has Description: ${!!product.image_description}`);
  console.log(`   Has Embedding: ${!!product.embedding}`);
  console.log(`   Description: "${product.image_description?.substring(0, 100)}..."\n`);

  if (!product.embedding) {
    console.log('❌ ISSUE: Product has no embedding!');
    console.log('   Fix: Run POST /products/generate-embeddings');
    return;
  }

  // 3. Test actual search with customer description
  const customerDescription = "gray zip-up hoodie with a classic casual style. The hoodie has a prominent, distressed text graphic on the front that reads 'WASTED.' A distinctive feature is its interior, lined with a contrasting leopard print pattern";

  console.log('🧪 Testing search with customer description...\n');

  const queryEmbedding = await generateEmbedding(customerDescription);

  const { data: matches, error } = await supabase.rpc('match_products_by_embedding', {
    query_embedding: queryEmbedding,
    match_brand_id: '6fe9cfc8-21e9-442f-9b6f-4f09f6c13823',
    match_threshold: 0.0, // NO threshold - see all results
    match_count: 10
  });

  if (error) {
    console.log('❌ Search error:', error.message);
    return;
  }

  console.log(`🎯 Found ${matches.length} products (no threshold):\n`);

  matches.forEach((m, i) => {
    console.log(`${i + 1}. ${m.name}`);
    console.log(`   Similarity: ${(m.similarity * 100).toFixed(1)}%`);
    console.log(`   In Stock: ${m.in_stock ? '✅' : '❌'}`);
    console.log(`   Description: "${m.image_description?.substring(0, 60)}..."\n`);
  });

  // 4. Check if ANY match > 40% threshold
  const highMatches = matches.filter(m => m.similarity > 0.4);
  if (highMatches.length === 0) {
    console.log('⚠️  ISSUE: No matches above 40% threshold');
    console.log('   Recommendation: Lower threshold to 0.3 or regenerate embeddings');
  } else {
    console.log(`✅ ${highMatches.length} matches above 40% threshold`);
  }
}

diagnose().catch(console.error);
```

**Run:**
```bash
node diagnose-image-search.js
```

---

## Step-by-Step Fix Procedure

### Step 1: Verify SQL Migration
```sql
-- In Supabase SQL Editor
SELECT prosrc FROM pg_proc WHERE proname = 'match_products_by_embedding';
```

If still has `AND products.in_stock = true`, run migration from [MIGRATION-IMAGE-SEARCH-OOS.md](MIGRATION-IMAGE-SEARCH-OOS.md).

---

### Step 2: Check Product Embeddings
```sql
SELECT
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) as with_embeddings,
  COUNT(*) FILTER (WHERE embedding IS NULL AND image_url IS NOT NULL) as needs_embeddings
FROM products
WHERE brand_id = '6fe9cfc8-21e9-442f-9b6f-4f09f6c13823';
```

If `needs_embeddings > 0`, generate them:
```bash
POST /products/generate-embeddings
```

---

### Step 3: Test Search
```bash
node diagnose-image-search.js
```

Look for:
- Product appears in results?
- Similarity score?
- If < 40%, lower threshold

---

### Step 4: Lower Threshold (If Needed)

Edit [routes/instagram.js:66](routes/instagram.js#L66):
```javascript
match_threshold: 0.3,  // or 0.35
```

---

## Most Likely Root Cause

**99% chance it's one of these:**

1. ⭐ **SQL migration not run** - Function still filters `in_stock = true`
2. ⭐ **Product has no embedding** - Never generated or failed to generate
3. ⚠️ **Threshold too high** - Embedding similarity is 35-39% (below 40%)

**Least likely:**
- Brand ID mismatch (would affect all searches)
- Extension/index missing (would cause SQL errors, not 0 results)

---

## Immediate Action Items

1. **Check SQL function** - Does it have `in_stock` filter?
2. **Check product embedding** - Does `embedding IS NOT NULL`?
3. **Run diagnostic script** - See actual similarity scores
4. **If needed, regenerate embeddings** - POST `/products/generate-embeddings`
5. **If needed, lower threshold** - Try 0.3 instead of 0.4

---

## Expected Outcome After Fix

```
📸 Processing customer image with vector search...
🔍 Customer image described as: gray zip-up hoodie with leopard print lining and "WASTED" text
🎯 Found 1 similar products
   1. WSTDPTNL GREY LEOPARD HOODED ZIP-UP (38% match, out of stock)
🤖 Luna reply (image match): "This looks like our 'WSTDPTNL GREY LEOPARD HOODED ZIP-UP' (1150 EGP), but unfortunately it's currently out of stock ❌..."
```

The system should work once the root cause is identified and fixed!
