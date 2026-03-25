# Instagram Image Search with Vector Similarity

AI-powered product matching for customer images in Instagram DMs using OpenAI vision and pgvector.

## Overview

When customers send product images via Instagram DM, Luna:
1. **Analyzes the image** using GPT-4o vision
2. **Generates description** of visual features (colors, style, type)
3. **Creates embedding** from the description
4. **Searches catalog** using vector similarity (cosine distance)
5. **Returns top 3 matches** with similarity scores
6. **Responds intelligently** based on match quality

## How It Works

### Flow Diagram

```
Customer sends image
        ↓
┌──────────────────────────┐
│  Download Image (base64) │
└────────────┬─────────────┘
             ↓
┌──────────────────────────┐
│  GPT-4o Vision Analysis  │
│  "Red hoodie with logo"  │
└────────────┬─────────────┘
             ↓
┌──────────────────────────┐
│  Generate Embedding      │
│  text-embedding-3-small  │
└────────────┬─────────────┘
             ↓
┌──────────────────────────┐
│  pgvector Search         │
│  Cosine Similarity       │
│  match_threshold: 0.4    │
└────────────┬─────────────┘
             ↓
┌──────────────────────────┐
│  Top 3 In-Stock Matches  │
│  with similarity scores  │
└────────────┬─────────────┘
             ↓
┌──────────────────────────┐
│  GPT-4o-mini Response    │
│  Based on match quality  │
└──────────────────────────┘
```

## Architecture Changes

### 1. Instagram Webhook Handler (routes/instagram.js)

**New Function:**
```javascript
async function findSimilarProducts(imageUrl, brandId)
```

**Image Flow:**
```javascript
if (imageUrl) {
  // Use vector search instead of GPT-4o vision directly
  const { matches, queryDescription } = await findSimilarProducts(imageUrl, brand_id);

  if (matches.length > 0) {
    // Build focused prompt with top matches
    // Use GPT-4o-mini (cheaper & faster)
  } else {
    // Fallback message
  }
} else {
  // Normal text conversation
}
```

**Before vs After:**

| Before | After |
|--------|-------|
| GPT-4o vision on every image | Vector search first |
| All products in prompt | Only top 3 matches |
| Slow response time | Fast response |
| Higher cost per image | Lower cost per image |

### 2. Vector Search Function (SQL)

**Function:** `match_products_by_embedding()`

**Parameters:**
- `query_embedding` - 1536-dimensional vector
- `match_brand_id` - UUID of brand
- `match_threshold` - Minimum similarity (default: 0.4)
- `match_count` - Max results (default: 3)

**Returns:**
```sql
TABLE (
  id uuid,
  name text,
  price decimal,
  image_url text,
  image_description text,
  in_stock boolean,
  similarity float  -- 0.0 to 1.0
)
```

**Query:**
```sql
SELECT ...
FROM products
WHERE embedding IS NOT NULL
  AND brand_id = match_brand_id
  AND in_stock = true  -- Only in-stock products!
  AND 1 - (embedding <=> query_embedding) > match_threshold
ORDER BY embedding <=> query_embedding
LIMIT match_count;
```

**Key Features:**
- ✅ Only searches in-stock products
- ✅ Brand-specific results
- ✅ Cosine similarity operator `<=>`
- ✅ HNSW index for sub-ms search
- ✅ Configurable threshold

## Response Quality by Similarity Score

| Similarity | Quality | Luna's Behavior |
|-----------|---------|-----------------|
| > 70% | **Excellent** | Confident match: "Yes! I found it!" |
| 50-70% | **Good** | Uncertain: "I found something similar..." |
| 40-50% | **Fair** | Cautious: "This might be similar, but..." |
| < 40% | **Poor** | No match: "Sorry, couldn't find exact match" |

### Example Responses

**High Similarity (85%):**
```
Yes! I found it! That looks like our "EVOLVE Red Hoodie" 😊

Price: 599 EGP
Availability: ✅ In stock and ready to ship!

Would you like to order this?
```

**Medium Similarity (55%):**
```
I found something similar! Check out our "EVOLVE Grey Hoodie"

It matches your image by about 55%
Price: 499 EGP

Is this what you're looking for? 🤔
```

**Low Similarity (No Matches):**
```
Sorry, I couldn't find an exact match for this item in our current collection.

Could you describe what you're looking for? For example:
- Color?
- Style?
- Type of product?

That way I can help you find something similar! 😊
```

## Setup & Prerequisites

### 1. Database Migration

Run [add-product-embeddings.sql](add-product-embeddings.sql):

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Add columns
ALTER TABLE products ADD COLUMN embedding vector(1536);
ALTER TABLE products ADD COLUMN image_description TEXT;

-- Create index
CREATE INDEX idx_products_embedding ON products
USING hnsw (embedding vector_cosine_ops);

-- Create search function
CREATE FUNCTION match_products_by_embedding(...) ...
```

### 2. Generate Embeddings

Products must have embeddings before image search works:

**Automatic (on sync):**
```bash
POST /products/sync
# Embeddings generated in background
```

**Manual:**
```bash
POST /products/generate-embeddings
Authorization: Bearer <jwt>
```

**Check coverage:**
```sql
SELECT
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) as has_embedding,
  COUNT(*) FILTER (WHERE embedding IS NULL AND image_url IS NOT NULL) as needs_embedding
FROM products
WHERE brand_id = 'your-brand-id';
```

### 3. Environment Variables

```env
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://...
SUPABASE_KEY=eyJ...
```

## Testing

### Test Script

```bash
node test-image-search.js
```

**What it does:**
1. Finds a product with embeddings
2. Uses its image as test query
3. Runs vector similarity search
4. Shows top matches with similarity scores
5. Simulates Luna's response

### Manual Test via Instagram

1. Send a product image to your Instagram page
2. Watch server logs:

```
📸 Processing customer image with vector search...
🔍 Customer image described as: A red pullover hoodie with white logo
🎯 Found 2 similar products
🤖 Luna reply (image match): "Yes! I found it! That looks like..."
```

### Debug Checklist

**No matches found?**
- [ ] Products have embeddings? `SELECT COUNT(*) FROM products WHERE embedding IS NOT NULL`
- [ ] Function exists? `SELECT proname FROM pg_proc WHERE proname = 'match_products_by_embedding'`
- [ ] Products in stock? Search only returns `in_stock = true`
- [ ] Threshold too high? Try lowering from 0.4 to 0.3

**Slow response?**
- [ ] HNSW index created? `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_products_embedding'`
- [ ] Too many products? Limit search with better threshold

**Vision errors?**
- [ ] Image URL accessible?
- [ ] OpenAI API key valid?
- [ ] Image format supported? (JPG, PNG, WebP)

## Performance

### Response Times

| Step | Time | Notes |
|------|------|-------|
| Download image | 100-500ms | Depends on image size |
| GPT-4o vision | 1-2s | Generate description |
| Embedding | 200-400ms | text-embedding-3-small |
| Vector search | <10ms | HNSW index |
| GPT-4o-mini reply | 500ms-1s | Generate response |
| **Total** | **2-4s** | End-to-end |

**Comparison (Old vs New):**

| Metric | Before (Direct Vision) | After (Vector Search) |
|--------|----------------------|----------------------|
| First API call | GPT-4o vision | GPT-4o vision |
| Search method | Scan all products | pgvector (3 products) |
| Final response | GPT-4o vision | GPT-4o-mini |
| Cost per image | ~$0.015 | ~$0.012 |
| Response time | 3-5s | 2-4s |

### Cost Analysis

**Per image query:**
- GPT-4o vision (description): $0.01
- text-embedding-3-small: $0.0001
- GPT-4o-mini (response): $0.002
- **Total: ~$0.012 per image**

**Monthly estimate (100 image queries/day):**
- Daily: $1.20
- Monthly: $36

## Similarity Threshold Tuning

Default threshold: **0.4** (40% similarity)

### How to Adjust

Edit [routes/instagram.js:66](routes/instagram.js#L66):

```javascript
const { data: matches, error } = await supabase.rpc('match_products_by_embedding', {
  query_embedding: queryEmbedding,
  match_brand_id: brandId,
  match_threshold: 0.4,  // <-- Adjust this
  match_count: 3
});
```

### Threshold Guidelines

| Threshold | Behavior | Use Case |
|-----------|----------|----------|
| 0.6+ | Very strict | High-end fashion (exact matches only) |
| 0.5 | Balanced | General retail |
| 0.4 | Relaxed | Large catalogs, varied styles |
| 0.3 | Very relaxed | Small catalogs, suggestions |

**Recommendation:** Start with 0.4, adjust based on:
- Customer feedback
- Match quality
- Catalog diversity

## Integration Points

### 1. Instagram DM Flow

Customer sends image → `handleIncomingMessage()` → `findSimilarProducts()` → Vector search → Luna responds

### 2. Product Sync Flow

Shopify sync → Background embeddings → Vector index updated → Image search ready

### 3. Knowledge Base

Image responses still respect:
- Language rules (match customer's language)
- Brand tone/guidelines
- Order-taking flow
- FAQ answers

## Future Enhancements

- [ ] Multi-image products (best angle matching)
- [ ] Color filtering ("show me this in blue")
- [ ] Style transfer ("similar but cheaper")
- [ ] Customer upload analytics
- [ ] A/B test threshold values
- [ ] Hybrid search (text + image)
- [ ] "Shop the look" (outfit matching)

## Troubleshooting

### Error: "match_products_by_embedding does not exist"

**Solution:** Run the SQL migration
```bash
# Execute add-product-embeddings.sql in Supabase SQL Editor
```

### Error: "column embedding does not exist"

**Solution:** Add columns to products table
```sql
ALTER TABLE products ADD COLUMN embedding vector(1536);
ALTER TABLE products ADD COLUMN image_description TEXT;
```

### Warning: "No products with embeddings found"

**Solution:** Generate embeddings
```bash
POST /products/generate-embeddings
# or
node test-embeddings.js
```

### Issue: All similarities < 40%

**Possible causes:**
1. Query image quality too low
2. Products not visually similar
3. Descriptions too generic

**Solutions:**
- Lower threshold to 0.3
- Generate better product descriptions
- Add more product images

### Issue: Wrong products matched

**Debug:**
```sql
-- Check what embeddings look like
SELECT name, image_description, embedding IS NOT NULL
FROM products
WHERE brand_id = 'your-brand-id'
LIMIT 5;
```

**Solutions:**
- Regenerate embeddings with better prompts
- Fine-tune vision prompt in `findSimilarProducts()`
- Add more visual context to product names

## Code Reference

### Main Files

| File | Purpose |
|------|---------|
| [routes/instagram.js](routes/instagram.js) | Image search integration |
| [lib/embeddings.js](lib/embeddings.js) | Embedding generation |
| [add-product-embeddings.sql](add-product-embeddings.sql) | Database schema |
| [test-image-search.js](test-image-search.js) | Testing script |

### Key Functions

```javascript
// Find similar products by image
findSimilarProducts(imageUrl, brandId)

// Generate embedding for product
generateProductEmbedding(product)

// Batch generate for brand
generateEmbeddingsForBrand(brandId)

// SQL vector search
match_products_by_embedding(query_embedding, match_brand_id, threshold, count)
```

## Success Metrics

Track these to measure effectiveness:

1. **Match Rate**: % of images that return matches
2. **Conversion Rate**: % of matches → orders
3. **Avg Similarity**: Mean similarity score
4. **Response Time**: End-to-end latency
5. **Cost per Image**: OpenAI API costs

**Target Metrics:**
- Match rate: > 60%
- Avg similarity: > 0.55
- Response time: < 3s
- Cost per image: < $0.015

---

**Ready to deploy!** 🚀

The image search system is production-ready and will automatically handle customer images in Instagram DMs.
