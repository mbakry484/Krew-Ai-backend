-- Migration: Add columns for Shopify expiring offline access tokens
-- Shopify now requires expiring tokens. We need to store the refresh_token
-- and track when the access_token expires so we can auto-refresh it.

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN integrations.refresh_token IS 'Shopify refresh token for rotating expiring offline access tokens';
COMMENT ON COLUMN integrations.token_expires_at IS 'When the current Shopify access_token expires (typically 1 hour after issue)';
