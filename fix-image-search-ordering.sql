-- Fix match_products_by_embedding to sort purely by visual similarity.
-- Removing the in_stock DESC priority which was forcing the only in-stock product
-- to always appear first regardless of how poor the visual match was.
-- Client-side code now handles in_stock display — the DB just finds the best matches.

CREATE OR REPLACE FUNCTION match_products_by_embedding(
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
    products.embedding <=> query_embedding  -- Sort by best visual similarity only
  LIMIT match_count;
END;
$$;
