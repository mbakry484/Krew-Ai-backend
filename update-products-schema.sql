-- Update products table to support Shopify sync requirements
-- Run this in Supabase SQL Editor

-- Add new columns
ALTER TABLE products
ADD COLUMN IF NOT EXISTS user_id TEXT,
ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EGP',
ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS in_stock BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create index on shopify_product_id for faster upserts
CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id ON products(shopify_product_id);

-- Create index on user_id
CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
