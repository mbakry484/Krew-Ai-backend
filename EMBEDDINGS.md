# Product Image Embeddings System

This system automatically generates AI-powered descriptions and embeddings for product images, enabling semantic search and image-based product matching.

## Overview

When products are synced from Shopify, the system:
1. **Analyzes product images** using GPT-4o vision
2. **Generates text descriptions** of visual features
3. **Creates embeddings** (1536-dimensional vectors) for semantic search
4. **Stores** descriptions and embeddings in Supabase

## Setup

### 1. Run Database Migration

Execute the SQL migration in Supabase SQL Editor:

```bash
# File: add-product-embeddings.sql
```

This will:
- Enable the `pgvector` extension
- Add `image_description` (TEXT) and `embedding` (vector(1536)) columns
- Create HNSW index for fast vector similarity search
- Add `match_products()` function for semantic search

### 2. Environment Variables

Ensure your `.env` has:
```env
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://...
SUPABASE_KEY=eyJ...
```

## How It Works

### Automatic Background Generation

Embeddings are generated automatically after product sync:

**Bulk Sync:**
```bash
POST /products/sync
{
  "shop_domain": "example.myshopify.com",
  "products": [...]
}
```
→ Responds immediately
→ Generates embeddings in background for all products

**Single Product Update:**
```bash
POST /webhook/shopify/product-update
{
  "shop_domain": "example.myshopify.com",
  "product": {...}
}
```
→ Responds immediately
→ Generates embedding in background if product has image

### Manual Generation

**Protected endpoint** (requires JWT authentication):

```bash
POST /products/generate-embeddings
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Generating embeddings for 15 products. This will take a few minutes.",
  "count": 15,
  "status": "processing"
}
```

## Database Schema

### products Table

| Column | Type | Description |
|--------|------|-------------|
| `image_description` | TEXT | AI-generated description of product image |
| `embedding` | vector(1536) | Text embedding for semantic search |
| `image_url` | TEXT | URL of product image |
| `name` | TEXT | Product name |

### Example Data

```sql
SELECT
  name,
  image_description,
  embedding IS NOT NULL as has_embedding
FROM products
WHERE brand_id = 'your-brand-id'
LIMIT 5;
```

## Vector Search

### Find Similar Products

Use the `match_products()` function to find visually similar products:

```javascript
const { generateProductEmbedding } = require('./lib/embeddings');

// Generate embedding for query image
const queryEmbedding = await generateProductEmbedding({
  shopify_product_id: 'temp',
  name: 'Query',
  image_url: 'https://example.com/query-image.jpg'
});

// Search for similar products
const { data: results } = await supabase.rpc('match_products', {
  query_embedding: queryEmbedding,
  match_threshold: 0.5,  // Minimum similarity score (0-1)
  match_count: 5,         // Max results
  p_brand_id: brandId     // Optional: filter by brand
});
```

**Results:**
```json
[
  {
    "id": "uuid",
    "name": "Red Hoodie",
    "image_description": "A bright red pullover hoodie...",
    "price": 59.99,
    "similarity": 0.87
  },
  ...
]
```

## Image Search API

The `lib/embeddings.js` module exports:

### `generateProductEmbedding(product)`

Generate embedding for a single product.

**Parameters:**
- `product.shopify_product_id` (string) - Product ID
- `product.name` (string) - Product name
- `product.image_url` (string) - Image URL

**Returns:** `Promise<number[]|null>` - Embedding vector or null

### `generateEmbeddingsForBrand(brandId)`

Generate embeddings for all products of a brand that don't have embeddings yet.

**Parameters:**
- `brandId` (string) - UUID of brand

**Returns:** `Promise<void>`

### `searchProductsByImage(brandId, queryImageUrl, limit)`

Search for visually similar products using an image.

**Parameters:**
- `brandId` (string) - UUID of brand
- `queryImageUrl` (string) - URL of query image
- `limit` (number) - Max results (default 5)

**Returns:** `Promise<Array>` - Similar products with similarity scores

## Performance

### Rate Limits

- OpenAI API has rate limits
- System adds 500ms delay between each product
- For 100 products: ~50 seconds + API time

### Costs

**Per product:**
- GPT-4o vision call (description): ~$0.01
- text-embedding-3-small: ~$0.0001

**Example:** 100 products ≈ $1.01

### Index Performance

- HNSW index enables sub-millisecond vector search
- Configured for: `m=16, ef_construction=64`
- Optimized for recall/speed tradeoff

## Testing

### Test Single Product

```bash
node test-embeddings.js
```

This will:
1. Fetch a product with an image
2. Generate description and embedding
3. Save to database
4. Verify the save

### Monitor Background Jobs

Watch server logs for:
```
🔄 Generating embeddings for 15 products...
📝 Description for Red Hoodie: A bright red pullover...
✅ Embedding generated for Red Hoodie
✅ Embedding generation complete for brand abc-123
   Success: 14, Failed: 1
```

## Use Cases

### 1. Visual Product Search
Customer uploads image → Find similar products in catalog

### 2. Product Recommendations
Show visually similar products on product pages

### 3. Duplicate Detection
Find duplicate or near-duplicate products

### 4. Customer Support
"Show me the blue shirt" → Search by color/style description

## Troubleshooting

### No embeddings generated?

**Check:**
1. Products have `image_url` set
2. OpenAI API key is valid
3. Image URLs are publicly accessible
4. Check logs for errors

```bash
# Count products with/without embeddings
SELECT
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) as has_embedding,
  COUNT(*) FILTER (WHERE embedding IS NULL AND image_url IS NOT NULL) as needs_embedding,
  COUNT(*) FILTER (WHERE image_url IS NULL) as no_image
FROM products
WHERE brand_id = 'your-brand-id';
```

### Rate limit errors?

Increase delay in `lib/embeddings.js`:
```javascript
await new Promise(r => setTimeout(r, 1000)); // 1 second
```

### Vector search not working?

**Ensure:**
1. pgvector extension is enabled
2. HNSW index was created
3. `match_products()` function exists

```sql
-- Check extension
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Check index
SELECT * FROM pg_indexes WHERE indexname = 'idx_products_embedding';

-- Check function
SELECT proname FROM pg_proc WHERE proname = 'match_products';
```

## Future Enhancements

- [ ] Webhook for embedding completion
- [ ] Batch processing for large catalogs
- [ ] Image similarity threshold tuning
- [ ] Multi-image products (multiple embeddings per product)
- [ ] Customer image upload API endpoint
- [ ] Analytics dashboard for embedding coverage

## Architecture

```
┌─────────────────┐
│  Shopify Sync   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      Background
│  Product Upsert │ ──────────────┐
└─────────────────┘                │
                                   ▼
                          ┌──────────────────┐
                          │  Embeddings Job  │
                          └────────┬─────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
            ┌──────────┐   ┌──────────┐   ┌──────────┐
            │ Download │   │ GPT-4o   │   │ Embed    │
            │  Image   │→  │ Vision   │→  │  Text    │
            └──────────┘   └──────────┘   └──────────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │   Supabase   │
                                          │  + pgvector  │
                                          └──────────────┘
```
