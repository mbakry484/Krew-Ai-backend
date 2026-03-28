-- Add escalation support to conversations table
-- Run this in Supabase SQL Editor

-- Add escalation columns to conversations table
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS is_escalated BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS escalation_type TEXT, -- 'exchange', 'refund', 'delivery', 'general'
ADD COLUMN IF NOT EXISTS escalation_reason TEXT,
ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS escalated_by TEXT DEFAULT 'ai';

-- Create index for escalated conversations
CREATE INDEX IF NOT EXISTS idx_conversations_escalated ON conversations(is_escalated, brand_id);

-- Add comment
COMMENT ON COLUMN conversations.is_escalated IS 'Whether this conversation has been escalated to human team';
COMMENT ON COLUMN conversations.escalation_type IS 'Type of escalation: exchange, refund, delivery, general';
COMMENT ON COLUMN conversations.escalation_reason IS 'Human-readable reason for escalation';
COMMENT ON COLUMN conversations.escalated_at IS 'Timestamp when conversation was escalated';
COMMENT ON COLUMN conversations.escalated_by IS 'Who escalated: ai or human';

-- Optional: Create a view for escalated conversations
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
  c.created_at,
  c.updated_at,
  COUNT(m.id) as message_count,
  MAX(m.created_at) as last_message_at
FROM conversations c
LEFT JOIN messages m ON c.id = m.conversation_id
WHERE c.is_escalated = TRUE
GROUP BY c.id
ORDER BY c.escalated_at DESC;

COMMENT ON VIEW escalated_conversations IS 'View of all escalated conversations with message counts';
