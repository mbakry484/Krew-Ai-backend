-- Krew Backend Database Schema - Fixed Version
-- Run this in Supabase SQL Editor

-- First, disable RLS on all tables if they exist (to avoid conflicts)
ALTER TABLE IF EXISTS brands DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS integrations DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS knowledge_base DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS products DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS messages DISABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Enable all access for service role" ON brands;
DROP POLICY IF EXISTS "Enable all access for service role" ON integrations;
DROP POLICY IF EXISTS "Enable all access for service role" ON knowledge_base;
DROP POLICY IF EXISTS "Enable all access for service role" ON products;
DROP POLICY IF EXISTS "Enable all access for service role" ON conversations;
DROP POLICY IF EXISTS "Enable all access for service role" ON messages;

-- 1. Brands table
CREATE TABLE IF NOT EXISTS brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Integrations table (stores Instagram/Shopify credentials)
CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- 'instagram' or 'shopify'
  instagram_page_id TEXT UNIQUE, -- Meta Page ID
  access_token TEXT, -- Platform access token
  shopify_shop_domain TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Knowledge base table
CREATE TABLE IF NOT EXISTS knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE UNIQUE,
  brand_name TEXT,
  tone TEXT, -- Brand voice/tone
  guidelines TEXT, -- Brand guidelines
  faqs JSONB DEFAULT '[]'::jsonb, -- Array of {question, answer} objects
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Products table
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price DECIMAL(10, 2),
  availability TEXT, -- 'in_stock', 'out_of_stock', 'pre_order'
  sku TEXT,
  shopify_product_id TEXT,
  image_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL, -- Instagram IGSID or Shopify customer ID
  platform TEXT NOT NULL, -- 'instagram' or 'shopify'
  status TEXT DEFAULT 'active', -- 'active', 'resolved', 'archived'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Messages table
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL, -- 'customer', 'ai', 'human'
  content TEXT NOT NULL,
  platform_message_id TEXT, -- ID from Instagram/Shopify
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_integrations_brand_id ON integrations(brand_id);
CREATE INDEX IF NOT EXISTS idx_integrations_instagram_page_id ON integrations(instagram_page_id);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_conversations_brand_id ON conversations(brand_id);
CREATE INDEX IF NOT EXISTS idx_conversations_customer_id ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

-- RLS is disabled by default for service role access
-- Your backend uses the service role key, so it will have full access
-- If you want to add RLS later for user-level access, you can enable it then
