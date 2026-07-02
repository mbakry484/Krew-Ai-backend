,-- MIGRATION: Fix image search recall (run in Supabase SQL Editor)
--
-- PROBLEM: The HNSW approximate index on products.embedding has terrible
-- recall — verified 2026-07-02: for a customer photo of a white tank top,
-- exact search ranks "Black Tank top" (68.9%) and "White Tank top" (67.5%)
-- first, but the indexed query returned unrelated polos at 47.9% because the
-- true nearest neighbors were never visited by the approximate graph scan.
-- This is why image matching only worked occasionally.
--
-- FIX: Drop the index. With only a few hundred products, an exact scan is
-- sub-millisecond and ALWAYS returns the true nearest neighbors. Revisit an
-- index (with pgvector iterative scans + tuned ef_search) only if the
-- products table grows past ~100k rows.

DROP INDEX IF EXISTS idx_products_embedding;

-- Also ensure the search function orders purely by similarity. Ordering by
-- in_stock first can evict the true match from the LIMITed result set
-- (e.g. an out-of-stock exact match pushed out by weaker in-stock
-- candidates). Callers handle stock status themselves.
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
  ORDER BY products.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_products_by_embedding IS 'Instagram image search - returns ALL products (in-stock and OOS) for a brand ordered by similarity above threshold. Exact scan (no ANN index) for perfect recall.';
