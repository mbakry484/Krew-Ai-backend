const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Service-role client used only to validate Supabase JWTs.
// createClient is cheap; this module is required once at startup.
const _supabaseForAuth = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/**
 * Return true if the JWT payload's `iss` claim looks like a Supabase Auth token.
 * We decode WITHOUT verifying the signature here — verification happens below via
 * supabase.auth.getUser(), which validates the token against Supabase's public key.
 * This is purely used to pick the validation path, not to trust the payload.
 */
function looksLikeSupabaseToken(token) {
  try {
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    // Supabase JWTs carry iss = "https://<ref>.supabase.co/auth/v1"
    return typeof payload.iss === 'string' && payload.iss.includes('/auth/v1');
  } catch {
    return false;
  }
}

/**
 * Middleware to verify access tokens on protected routes.
 *
 * Strategy:
 *   1. If the token looks like a Supabase JWT (has iss=/auth/v1), validate it
 *      via supabase.auth.getUser(). Then look up the user's row in our `users`
 *      table by email so req.user.user_id is always our internal UUID.
 *   2. Otherwise fall back to the legacy custom JWT signed with JWT_SECRET.
 *
 * req.user shape (same in both paths so downstream routes are unaffected):
 *   { user_id, email, type?, supabase_uid? }
 */
async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  // ── Path 1: Supabase JWT ────────────────────────────────────────────────────
  if (looksLikeSupabaseToken(token)) {
    try {
      const { data: { user }, error } = await _supabaseForAuth.auth.getUser(token);

      if (error || !user) {
        // Could be expired or revoked — tell the client to refresh
        return res.status(401).json({ error: 'Token expired' });
      }

      // Look up our internal user row by email to get the brand-scoped user_id
      const { data: dbUser } = await _supabaseForAuth
        .from('users')
        .select('id, brand_id')
        .eq('email', user.email)
        .maybeSingle();

      req.user = {
        user_id: dbUser?.id ?? user.id, // fall back to Supabase UID if row not yet created
        email: user.email,
        supabase_uid: user.id,
        brand_id: dbUser?.brand_id ?? null,
      };
      return next();
    } catch (err) {
      console.error('[auth] Supabase JWT validation error:', err.message);
      return res.status(403).json({ error: 'Invalid token' });
    }
  }

  // ── Path 2: Legacy custom JWT (kept for rollback / existing accounts) ───────
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'access') {
      return res.status(403).json({ error: 'Invalid token type' });
    }
    req.user = decoded; // { user_id, email, type: 'access', iat, exp }
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

/**
 * Resolve a raw access token (from a header OR a query param) to our internal
 * user identity, supporting BOTH Supabase Auth JWTs and legacy custom JWTs.
 *
 * Use this for browser-redirect flows (e.g. /auth/instagram) where the token
 * arrives as a query param and the verifyToken middleware can't run off the
 * Authorization header.
 *
 * @returns {Promise<{ user_id: string, email: string|null } | null>} null if invalid.
 */
async function resolveUserFromToken(token) {
  if (!token) return null;

  // ── Supabase JWT ──
  if (looksLikeSupabaseToken(token)) {
    try {
      const { data: { user }, error } = await _supabaseForAuth.auth.getUser(token);
      if (error || !user) return null;

      const { data: dbUser } = await _supabaseForAuth
        .from('users')
        .select('id')
        .eq('email', user.email)
        .maybeSingle();

      return { user_id: dbUser?.id ?? user.id, email: user.email };
    } catch {
      return null;
    }
  }

  // ── Legacy custom JWT ──
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return { user_id: decoded.user_id, email: decoded.email ?? null };
  } catch {
    return null;
  }
}

module.exports = { verifyToken, resolveUserFromToken };
