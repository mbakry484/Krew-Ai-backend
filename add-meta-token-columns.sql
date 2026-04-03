-- Migration: Add long-lived Meta token columns to the brands table
-- Run this in the Supabase SQL Editor

-- Add columns for Meta Page Access Token management
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS page_access_token TEXT,
  ADD COLUMN IF NOT EXISTS long_lived_user_token TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fb_page_id TEXT;

-- Add a comment for documentation
COMMENT ON COLUMN brands.page_access_token IS 'Never-expiring page access token derived from long-lived user token';
COMMENT ON COLUMN brands.long_lived_user_token IS '60-day user token used to re-derive the page token';
COMMENT ON COLUMN brands.token_expires_at IS 'Expiry timestamp of the long-lived user token (null = never expires)';
COMMENT ON COLUMN brands.fb_page_id IS 'Facebook Page ID linked to this brand';
