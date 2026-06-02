-- Migration: Add refresh_tokens table for JWT refresh token support
-- Access tokens: 15 minutes
-- Refresh tokens: 7 days, single-use (rotated on each refresh)
--
-- Security model: selector/verifier split
--   selector      — random 16-byte hex, stored plain, used to find the row (not secret)
--   verifier_hash — bcrypt hash of the secret 32-byte verifier (never stored raw)
--   Client receives the opaque token: "<selector>.<verifier>" (base64url)
--   DB lookup: WHERE selector = ? THEN bcrypt.compare(verifier, verifier_hash)

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selector      TEXT NOT NULL UNIQUE,   -- non-secret lookup key
  verifier_hash TEXT NOT NULL,          -- bcrypt hash of the secret verifier
  expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fast lookup by selector (used on every refresh)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_selector ON refresh_tokens(selector);
-- Cleanup queries (revoke all sessions for a user)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- Enable RLS — the backend uses the service role key which bypasses RLS,
-- so this is purely a safety net against accidental anon/user-scoped access.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

-- No policies = no access for anon or authenticated roles.
-- Service role always bypasses RLS, so the backend is unaffected.
