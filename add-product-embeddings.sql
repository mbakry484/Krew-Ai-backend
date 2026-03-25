-- Add product image description and embedding columns
-- Run this in Supabase SQL Editor

-- Step 1: Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Add columns to products table
ALTER TABLE products
ADD COLUMN IF NOT EXISTS image_description TEXT,
ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Step 3: Create index for vector similarity search
-- This enables fast nearest-neighbor search using HNSW algorithm
CREATE INDEX IF NOT EXISTS idx_products_embedding
ON products
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Step 4: Create function for vector similarity search
CREATE OR REPLACE FUNCTION match_products(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5,
  p_brand_id uuid DEFAULT NULL
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
    1 - (products.embedding <=> query_embedding) AS similarity
  FROM products
  WHERE
    products.embedding IS NOT NULL
    AND (p_brand_id IS NULL OR products.brand_id = p_brand_id)
    AND 1 - (products.embedding <=> query_embedding) > match_threshold
  ORDER BY products.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Step 5: Create optimized function for Instagram image search
-- Updated to include ALL products (in-stock and out-of-stock)
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

-- Step 6: Add comments for documentation
COMMENT ON COLUMN products.image_description IS 'AI-generated description of product image using GPT-4o vision';
COMMENT ON COLUMN products.embedding IS 'Text embedding vector (1536 dimensions) for semantic search using text-embedding-3-small';
COMMENT ON FUNCTION match_products IS 'Find similar products using vector similarity search. Returns products ranked by cosine similarity to query embedding.';
COMMENT ON FUNCTION match_products_by_embedding IS 'Instagram image search - returns ALL products (in-stock and OOS) for a brand, prioritizing in-stock products first, with similarity above threshold.';
