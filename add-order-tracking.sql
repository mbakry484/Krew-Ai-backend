-- Migration: Add order tracking support
-- Run this in Supabase SQL Editor

-- 1. Add metadata column to conversations table (if not exists)
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{
  "discussed_products": [],
  "current_order": null,
  "collected_info": {
    "name": null,
    "phone": null,
    "address": null
  },
  "awaiting": null
}'::jsonb;

-- 2. Create orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  shopify_order_id TEXT,
  order_number TEXT,
  product_name TEXT NOT NULL,
  product_id UUID,
  variant_id TEXT,
  price DECIMAL(10, 2),
  currency TEXT DEFAULT 'EGP',
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_orders_brand_id ON orders(brand_id);
CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id ON orders(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_conversations_metadata ON conversations USING gin(metadata);

-- 4. Enable Row Level Security on orders table
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- 5. Create RLS policy for orders (adjust based on your auth setup)
CREATE POLICY "Enable all access for service role" ON orders FOR ALL USING (true);

-- 6. Add comment for documentation
COMMENT ON TABLE orders IS 'Stores orders placed through Instagram DM conversations';
COMMENT ON COLUMN conversations.metadata IS 'Conversation metadata including discussed products, order state, and customer info';
