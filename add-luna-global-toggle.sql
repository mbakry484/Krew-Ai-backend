-- Add luna_global_enabled column to brands table
-- When false, Luna will not respond to any conversations for this brand
ALTER TABLE brands ADD COLUMN IF NOT EXISTS luna_global_enabled BOOLEAN DEFAULT true;
