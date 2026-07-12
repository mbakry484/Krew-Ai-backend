-- Adds embedding_source so we can tell how each product's embedding was produced:
--   'vision'        — described from the primary product image (images[0])
--   'vision_alt'    — primary image was refused/failed; described from an alternate image
--   'text_fallback' — all image attempts failed; embedded from title/type/description/alt text
-- Lets us measure image-search quality per source and find products whose primary
-- photo trips content moderation (candidates for a better hero image).
--
-- Run this BEFORE the next resync: generateProductEmbedding writes this column,
-- so without it every product UPDATE fails.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS embedding_source TEXT;

COMMENT ON COLUMN products.embedding_source IS 'How the product embedding was produced: vision | vision_alt | text_fallback';
