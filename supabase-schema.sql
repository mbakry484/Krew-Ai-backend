-- Krew Backend Database Schema
-- Run this in Supabase SQL Editor

-- 1. Brands table (if not exists)
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
  situations_enabled BOOLEAN DEFAULT false,
  situations JSONB DEFAULT '[]'::jsonb, -- Array of {text} objects describing brand situations
  size_guides_enabled BOOLEAN DEFAULT false,
  size_guides JSONB DEFAULT '[]'::jsonb, -- Array of {product_name, content, image_url} objects
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration: add new columns if table already exists
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS situations_enabled BOOLEAN DEFAULT false;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS situations JSONB DEFAULT '[]'::jsonb;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS size_guides_enabled BOOLEAN DEFAULT false;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS size_guides JSONB DEFAULT '[]'::jsonb;

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

-- Enable Row Level Security (RLS) - Optional but recommended
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (adjust based on your auth setup)
-- For now, allowing service role access (your backend)
CREATE POLICY "Enable all access for service role" ON brands FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON integrations FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON knowledge_base FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON products FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON conversations FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON messages FOR ALL USING (true);
