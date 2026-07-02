-- Structured image matching: garment type gating + attribute-schema descriptions
-- Run this in Supabase SQL Editor BEFORE deploying the matching backend changes.
--
-- Why: image search previously embedded free-text descriptions, so cosine
-- similarity was dominated by overall "vibe" (colors/texture/mood) and a polo
-- could outrank a tank top for a tank-top query. Both sides now describe
-- images against a fixed attribute schema, and matching applies a soft penalty
-- when the garment type disagrees.

-- Step 1: New columns on products
ALTER TABLE products
ADD COLUMN IF NOT EXISTS product_type TEXT,        -- raw type from Shopify (productType)
ADD COLUMN IF NOT EXISTS garment_type TEXT,        -- normalized controlled-vocab type (vision-derived, Shopify fallback)
ADD COLUMN IF NOT EXISTS image_attributes JSONB;   -- structured attributes from GPT-4o vision

COMMENT ON COLUMN products.product_type IS 'Raw product type as set by the merchant in Shopify';
COMMENT ON COLUMN products.garment_type IS 'Normalized garment type from the controlled vocabulary (lib/garment-vocab.js), used for type-gated image matching';
COMMENT ON COLUMN products.image_attributes IS 'Structured attributes (type, colors, pattern, material, fit, neckline, sleeves, details, summary) from GPT-4o vision';

-- Step 2: Recreate match_products_by_embedding to also return garment_type.
-- DROP first: CREATE OR REPLACE cannot change a function''s return type.
DROP FUNCTION IF EXISTS match_products_by_embedding(vector, uuid, float, int);

CREATE FUNCTION match_products_by_embedding(
  query_embedding vector(1536),
  match_brand_id uuid,
  match_threshold float DEFAULT 0.35,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  shopify_product_id text,
  name text,
  description text,
  price decimal,
  image_url text,
  image_description text,
  garment_type text,
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
    products.garment_type,
    products.in_stock,
    products.availability,
    1 - (products.embedding <=> query_embedding) AS similarity
  FROM products
  WHERE
    products.embedding IS NOT NULL
    AND products.brand_id = match_brand_id
    AND 1 - (products.embedding <=> query_embedding) > match_threshold
  ORDER BY
    products.embedding <=> query_embedding  -- best visual similarity first; type penalty is applied client-side
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_products_by_embedding IS 'Instagram image search - returns candidate products for a brand ranked by cosine similarity, including garment_type for client-side type-penalty re-ranking.';

-- Step 3 (run AFTER deploying the backend): force a re-index of every product
-- so embeddings are regenerated under the structured attribute scheme.
-- The backend re-embeds any product whose garment_type is NULL, so clearing
-- embeddings is NOT needed — a resync (POST /integrations/shopify/resync) or
-- the next product sync will pick them all up automatically because
-- garment_type is NULL for every existing row after Step 1.
