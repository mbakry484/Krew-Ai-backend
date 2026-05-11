-- ============================================================
-- Krew AI — Conversations table patch for Supabase
-- Run this in the Supabase SQL Editor.
-- Safe to run on a fresh DB or on top of supabase-schema.sql.
-- ============================================================

-- 1. Users table (needed by auth routes)
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,
  first_name  TEXT,
  last_name   TEXT,
  business_name TEXT,
  brand_id    UUID REFERENCES brands(id) ON DELETE SET NULL,
  business_type TEXT,
  revenue_range TEXT,
  dm_volume   TEXT,
  pain_point  TEXT,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_brand_id ON users(brand_id);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

-- 2. Add customer identity + escalation columns to conversations (idempotent)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS customer_name     TEXT,                    -- Instagram display name e.g. "Sarah M."
  ADD COLUMN IF NOT EXISTS customer_username TEXT,                    -- Instagram username e.g. "sarah.style" (no @)
  ADD COLUMN IF NOT EXISTS is_escalated      BOOLEAN                  DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS escalation_type   TEXT,                    -- 'exchange' | 'refund' | 'delivery' | 'general'
  ADD COLUMN IF NOT EXISTS escalation_reason TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at      TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS escalated_by      TEXT DEFAULT 'ai';       -- 'ai' | 'human'

-- Index for searching by username
CREATE INDEX IF NOT EXISTS idx_conversations_customer_username
  ON conversations(customer_username)
  WHERE customer_username IS NOT NULL;

-- 3. Add metadata column to conversations (idempotent)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{
    "discussed_products": [],
    "current_order": null,
    "collected_info": {"name": null, "phone": null, "address": null},
    "awaiting": null
  }'::jsonb;

-- 4. Add image_url to messages (idempotent)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- 5. Additional indexes
CREATE INDEX IF NOT EXISTS idx_conversations_escalated
  ON conversations(is_escalated, brand_id);

CREATE INDEX IF NOT EXISTS idx_conversations_status
  ON conversations(status, brand_id);

CREATE INDEX IF NOT EXISTS idx_conversations_metadata
  ON conversations USING GIN(metadata);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(conversation_id, created_at);

-- 6. Auto-update updated_at trigger for conversations
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_conversations_updated_at ON conversations;
CREATE TRIGGER set_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_users_updated_at ON users;
CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 7. escalated_conversations view (used by /escalations route)
CREATE OR REPLACE VIEW escalated_conversations AS
SELECT
  c.id,
  c.brand_id,
  c.customer_id,
  c.platform,
  c.status,
  c.is_escalated,
  c.escalation_type,
  c.escalation_reason,
  c.escalated_at,
  c.escalated_by,
  c.metadata,
  c.created_at,
  c.updated_at,
  COUNT(m.id)              AS message_count,
  MAX(m.created_at)        AS last_message_at
FROM conversations c
LEFT JOIN messages m ON m.conversation_id = c.id
WHERE c.is_escalated = TRUE
GROUP BY c.id;

-- 8. RLS policy for users table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'users' AND policyname = 'Enable all access for service role'
  ) THEN
    EXECUTE 'CREATE POLICY "Enable all access for service role" ON users FOR ALL USING (true)';
  END IF;
END $$;
