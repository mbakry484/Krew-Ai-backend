-- ============================================================================
-- INTERACTIONS TABLE SCHEMA
-- ============================================================================
-- Groups messages into discrete customer interactions (sessions) for
-- analytics: sentiment analysis, issue detection, satisfaction scoring.
-- Run this in Supabase SQL Editor.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. INTERACTIONS TABLE
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  customer_username TEXT,

  -- Interaction boundary (time-gap based: new interaction after 30 min gap)
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  message_count INT NOT NULL DEFAULT 1,

  -- Message references for deep-linking from dashboard to conversation
  first_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  last_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,

  -- AI-analyzed fields (filled asynchronously by background job)
  sentiment TEXT CHECK (sentiment IN ('angry', 'frustrated', 'neutral', 'satisfied', 'happy')),
  sentiment_score FLOAT,              -- -1.0 to 1.0
  issue_category TEXT,                 -- AI-generated freely, e.g. 'sizing', 'late delivery', etc.
  issue_summary TEXT,                  -- One-line AI summary of the interaction
  resolution_status TEXT CHECK (resolution_status IN ('resolved', 'unresolved', 'escalated')),
  was_escalated BOOLEAN DEFAULT FALSE,

  -- Performance metrics
  response_time_avg_ms INT,            -- avg time between customer msg and AI reply

  -- Analysis tracking
  analyzed_at TIMESTAMP WITH TIME ZONE, -- NULL = not yet analyzed

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. INDEXES
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_interactions_brand_id ON interactions(brand_id);
CREATE INDEX IF NOT EXISTS idx_interactions_brand_created ON interactions(brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_conversation ON interactions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_interactions_customer ON interactions(brand_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_interactions_sentiment ON interactions(brand_id, sentiment);
CREATE INDEX IF NOT EXISTS idx_interactions_issue ON interactions(brand_id, issue_category);
CREATE INDEX IF NOT EXISTS idx_interactions_unanalyzed ON interactions(analyzed_at)
  WHERE analyzed_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. UPDATED_AT TRIGGER
-- ────────────────────────────────────────────────────────────────────────────
-- Reuses the update_updated_at_column() function created in refunds/exchanges schema.
-- If it doesn't exist yet, create it:
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_interactions_updated_at ON interactions;
CREATE TRIGGER update_interactions_updated_at
  BEFORE UPDATE ON interactions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all access for service role" ON interactions FOR ALL USING (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. VIEWS FOR DASHBOARD QUERIES
-- ────────────────────────────────────────────────────────────────────────────

-- Issues aggregation: groups by AI-generated issue_category
CREATE OR REPLACE VIEW issues_summary AS
SELECT
  brand_id,
  issue_category,
  COUNT(*) AS issue_count,
  AVG(sentiment_score) AS avg_sentiment_score,
  COUNT(*) FILTER (WHERE was_escalated) AS escalated_count,
  MIN(started_at) AS first_seen,
  MAX(started_at) AS last_seen
FROM interactions
WHERE issue_category IS NOT NULL
  AND analyzed_at IS NOT NULL
GROUP BY brand_id, issue_category;

-- Sentiment distribution per brand
CREATE OR REPLACE VIEW sentiment_distribution AS
SELECT
  brand_id,
  sentiment,
  COUNT(*) AS count,
  ROUND(COUNT(*)::numeric / NULLIF(SUM(COUNT(*)) OVER (PARTITION BY brand_id), 0) * 100, 1) AS percentage
FROM interactions
WHERE sentiment IS NOT NULL
  AND analyzed_at IS NOT NULL
GROUP BY brand_id, sentiment;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. DOCUMENTATION
-- ────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE interactions IS 'Groups conversation messages into discrete customer interaction sessions for analytics';
COMMENT ON COLUMN interactions .issue_category IS 'AI-generated issue label — not hardcoded, freely determined by analysis model';
COMMENT ON COLUMN interactions.first_message_id IS 'First message in this interaction — used for deep-linking from dashboard';
COMMENT ON COLUMN interactions.last_message_id IS 'Last message in this interaction — used for deep-linking from dashboard';
COMMENT ON COLUMN interactions.analyzed_at IS 'NULL means pending analysis; set when background job completes';

-- ============================================================================
-- SCHEMA CREATION COMPLETE!
-- ============================================================================
-- Next steps:
-- 1. Run this SQL in your Supabase SQL Editor
-- 2. The backend will automatically create interactions on incoming messages
-- 3. Background job analyzes interactions with gpt-4o-mini
-- ============================================================================
