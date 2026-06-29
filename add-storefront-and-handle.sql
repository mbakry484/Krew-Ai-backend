-- Storefront URL + product handles for clickable product links in DMs
-- Run this in Supabase SQL Editor

-- 1. Brand's published storefront domain (e.g. https://krew.com), fetched from
--    Shopify's shop.primaryDomain. Falls back to the .myshopify.com domain when
--    the brand hasn't configured a custom domain.
ALTER TABLE integrations
ADD COLUMN IF NOT EXISTS storefront_url TEXT;

-- 2. Product handle (slug) used to build storefront URLs:
--    {storefront_url}/products/{handle}
--    Plus the prebuilt canonical URL from Shopify when the product is published.
ALTER TABLE products
ADD COLUMN IF NOT EXISTS handle TEXT,
ADD COLUMN IF NOT EXISTS online_store_url TEXT;
