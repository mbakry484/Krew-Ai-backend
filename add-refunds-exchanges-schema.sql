-- ============================================================================
-- REFUNDS & EXCHANGES DATABASE SCHEMA
-- ============================================================================
-- This schema adds complete refund and exchange tracking to your system
-- Run this in Supabase SQL Editor
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. EXCHANGES TABLE
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exchanges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,

  -- Customer Info
  customer_id TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,

  -- Original Order Info
  original_order_number TEXT,
  original_product_name TEXT NOT NULL,
  original_product_sku TEXT,
  original_size TEXT,
  original_color TEXT,

  -- Exchange Details
  requested_product_name TEXT,
  requested_size TEXT,
  requested_color TEXT,
  exchange_reason TEXT NOT NULL, -- 'size_issue', 'defective', 'damaged', 'wrong_item', 'other'
  exchange_reason_details TEXT, -- Customer's description

  -- Status Tracking
  status TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' → 'approved' → 'shipped' → 'completed'
  -- OR 'pending' → 'rejected' → 'closed'

  -- Images/Evidence
  evidence_images JSONB DEFAULT '[]'::jsonb, -- Array of image URLs

  -- Team Notes
  internal_notes TEXT,
  resolved_by TEXT, -- Staff member who handled it
  resolution_details TEXT, -- What was done

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE
);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. REFUNDS TABLE
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,

  -- Customer Info
  customer_id TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,

  -- Original Order Info
  original_order_number TEXT,
  product_name TEXT NOT NULL,
  product_sku TEXT,
  order_amount DECIMAL(10, 2),
  currency TEXT DEFAULT 'EGP',

  -- Refund Details
  refund_amount DECIMAL(10, 2), -- May be partial refund
  refund_reason TEXT NOT NULL, -- 'defective', 'damaged', 'not_as_described', 'delivery_issue', 'other'
  refund_reason_details TEXT, -- Customer's description

  -- Status Tracking
  status TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' → 'approved' → 'processed' → 'completed'
  -- OR 'pending' → 'rejected' → 'closed'

  -- Payment Info
  refund_method TEXT, -- 'original_payment', 'bank_transfer', 'store_credit'
  bank_account_details TEXT, -- If bank transfer
  transaction_id TEXT, -- Payment processor transaction ID

  -- Images/Evidence
  evidence_images JSONB DEFAULT '[]'::jsonb, -- Array of image URLs

  -- Team Notes
  internal_notes TEXT,
  resolved_by TEXT, -- Staff member who handled it
  resolution_details TEXT, -- What was done
  rejection_reason TEXT, -- If rejected, why?

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. CREATE INDEXES FOR PERFORMANCE
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_exchanges_brand_id ON exchanges(brand_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_customer_id ON exchanges(customer_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_status ON exchanges(status);
CREATE INDEX IF NOT EXISTS idx_exchanges_conversation_id ON exchanges(conversation_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_created_at ON exchanges(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_refunds_brand_id ON refunds(brand_id);
CREATE INDEX IF NOT EXISTS idx_refunds_customer_id ON refunds(customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_conversation_id ON refunds(conversation_id);
CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON refunds(created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. CREATE VIEWS FOR EASY QUERYING
-- ────────────────────────────────────────────────────────────────────────────

-- Pending Exchanges View
CREATE OR REPLACE VIEW pending_exchanges AS
SELECT
  e.id,
  e.brand_id,
  e.customer_id,
  e.customer_name,
  e.customer_phone,
  e.original_product_name,
  e.original_size,
  e.requested_product_name,
  e.requested_size,
  e.exchange_reason,
  e.exchange_reason_details,
  e.status,
  e.created_at,
  c.id as conversation_id,
  COUNT(m.id) as message_count
FROM exchanges e
LEFT JOIN conversations c ON e.conversation_id = c.id
LEFT JOIN messages m ON c.id = m.conversation_id
WHERE e.status IN ('pending', 'approved', 'shipped')
GROUP BY e.id, c.id
ORDER BY e.created_at DESC;

-- Pending Refunds View
CREATE OR REPLACE VIEW pending_refunds AS
SELECT
  r.id,
  r.brand_id,
  r.customer_id,
  r.customer_name,
  r.customer_phone,
  r.product_name,
  r.order_amount,
  r.refund_amount,
  r.refund_reason,
  r.refund_reason_details,
  r.status,
  r.created_at,
  c.id as conversation_id,
  COUNT(m.id) as message_count
FROM refunds r
LEFT JOIN conversations c ON r.conversation_id = c.id
LEFT JOIN messages m ON c.id = m.conversation_id
WHERE r.status IN ('pending', 'approved', 'processed')
GROUP BY r.id, c.id
ORDER BY r.created_at DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. ENABLE ROW LEVEL SECURITY (Optional but recommended)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (your backend)
CREATE POLICY "Enable all access for service role" ON exchanges FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON refunds FOR ALL USING (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. ADD COMMENTS FOR DOCUMENTATION
-- ────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE exchanges IS 'Tracks all product exchange requests from customers';
COMMENT ON TABLE refunds IS 'Tracks all refund requests from customers';

COMMENT ON COLUMN exchanges.status IS 'Status: pending, approved, shipped, completed, rejected, closed';
COMMENT ON COLUMN refunds.status IS 'Status: pending, approved, processed, completed, rejected, closed';

COMMENT ON COLUMN exchanges.exchange_reason IS 'Reason codes: size_issue, defective, damaged, wrong_item, other';
COMMENT ON COLUMN refunds.refund_reason IS 'Reason codes: defective, damaged, not_as_described, delivery_issue, other';

COMMENT ON VIEW pending_exchanges IS 'View of all active exchange requests';
COMMENT ON VIEW pending_refunds IS 'View of all active refund requests';

-- ────────────────────────────────────────────────────────────────────────────
-- 7. ADD UPDATED_AT TRIGGER FUNCTIONS
-- ────────────────────────────────────────────────────────────────────────────

-- Create function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to exchanges table
DROP TRIGGER IF EXISTS update_exchanges_updated_at ON exchanges;
CREATE TRIGGER update_exchanges_updated_at
  BEFORE UPDATE ON exchanges
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to refunds table
DROP TRIGGER IF EXISTS update_refunds_updated_at ON refunds;
CREATE TRIGGER update_refunds_updated_at
  BEFORE UPDATE ON refunds
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────────────────────────────────────
-- 8. SAMPLE QUERIES (For Testing)
-- ────────────────────────────────────────────────────────────────────────────
-- Uncomment these to test after running the schema

-- Get all pending exchanges for a brand
-- SELECT * FROM pending_exchanges WHERE brand_id = 'your-brand-id-here';

-- Get all pending refunds for a brand
-- SELECT * FROM pending_refunds WHERE brand_id = 'your-brand-id-here';

-- Get exchange statistics by reason
-- SELECT exchange_reason, COUNT(*) as count
-- FROM exchanges
-- WHERE brand_id = 'your-brand-id-here'
-- GROUP BY exchange_reason;

-- Get refund statistics by status
-- SELECT status, COUNT(*) as count, SUM(refund_amount) as total_amount
-- FROM refunds
-- WHERE brand_id = 'your-brand-id-here'
-- GROUP BY status;

-- ============================================================================
-- SCHEMA CREATION COMPLETE!
-- ============================================================================
-- Next steps:
-- 1. Run this SQL in your Supabase SQL Editor
-- 2. Implement API routes (see routes/refunds.js and routes/exchanges.js)
-- 3. Connect to chatbot escalation flow
-- ============================================================================
