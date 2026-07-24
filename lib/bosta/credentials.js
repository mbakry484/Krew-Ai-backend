// =============================================================================
// BOSTA — per-brand credentials + connection state
// =============================================================================
// The ONE place that reads/writes ivy_bosta_credentials. Every caller gets a
// decrypted key from getCredentials() and never touches api_key_encrypted
// directly — that's what keeps the cipher from leaking across the codebase.
// =============================================================================

const crypto = require('crypto');
const supabase = require('../supabase');
const { encryptSecret, decryptSecret } = require('../crypto');
const { getTotalDeliveries, BostaError } = require('./client');

/**
 * Load a brand's credentials with the API key decrypted.
 * @returns {Promise<object|null>} row with `api_key` (plaintext, in-memory only)
 */
async function getCredentials(brandId) {
  const { data, error } = await supabase
    .from('ivy_bosta_credentials')
    .select('*')
    .eq('brand_id', brandId)
    .maybeSingle();
  if (error) throw new Error(`ivy_bosta_credentials read failed: ${error.message}`);
  if (!data) return null;

  return { ...data, api_key: decryptSecret(data.api_key_encrypted) };
}

/** All brands eligible for polling: connected and not in a terminal auth failure. */
async function listPollableBrands() {
  const { data, error } = await supabase
    .from('ivy_bosta_credentials')
    .select('*')
    .in('connection_status', ['active', 'error'])
    .order('last_poll_at', { ascending: true, nullsFirst: true });
  if (error) throw new Error(`ivy_bosta_credentials list failed: ${error.message}`);

  // 'invalid' and 'ip_blocked' are excluded above: they need a human (new key
  // or an IP allowlist entry). Polling them just burns quota and noise.
  return (data || []).map((row) => ({ ...row, api_key: decryptSecret(row.api_key_encrypted) }));
}

/**
 * Save a brand's API key after verifying it against Bosta.
 * Verification is mandatory — storing an unverified key means the founder
 * thinks they're connected while revenue silently never arrives.
 * @returns {Promise<{ok: true, totals: object} | {ok: false, kind: string, error: string}>}
 */
async function saveCredentials(brandId, apiKey, env = 'production') {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, kind: 'invalid', error: 'API key is required' };
  if (!['production', 'staging'].includes(env)) {
    return { ok: false, kind: 'error', error: 'env must be "production" or "staging"' };
  }

  let totals;
  try {
    totals = await getTotalDeliveries(key, env);
  } catch (err) {
    if (err instanceof BostaError) {
      // Bosta's own wording, verbatim — "Invalid API key" / IP guidance is more
      // actionable than anything we'd paraphrase.
      return { ok: false, kind: err.kind, error: err.message };
    }
    throw err;
  }

  const { data: existing } = await supabase
    .from('ivy_bosta_credentials')
    .select('brand_id, webhook_secret')
    .eq('brand_id', brandId)
    .maybeSingle();

  const row = {
    brand_id: brandId,
    api_key_encrypted: encryptSecret(key),
    env,
    // Preserve the webhook secret across key rotations — regenerating it would
    // silently break any webhook already registered with the old value.
    webhook_secret: existing?.webhook_secret || crypto.randomBytes(32).toString('hex'),
    connection_status: 'active',
    connection_error: null,
    updated_at: new Date().toISOString(),
  };

  const { error } = existing
    ? await supabase.from('ivy_bosta_credentials').update(row).eq('brand_id', brandId)
    : await supabase.from('ivy_bosta_credentials').insert(row);
  if (error) throw new Error(`ivy_bosta_credentials write failed: ${error.message}`);

  return { ok: true, totals, isNew: !existing };
}

/** Record the outcome of an API call against the connection's health. */
async function markConnectionStatus(brandId, status, errorMessage = null) {
  const patch = {
    connection_status: status,
    connection_error: errorMessage ? String(errorMessage).slice(0, 500) : null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('ivy_bosta_credentials').update(patch).eq('brand_id', brandId);
  if (error) console.error(`[bosta] failed to mark ${brandId} as ${status}: ${error.message}`);
}

/** Map a BostaError onto connection_status. Rate limits are transient — not a status change. */
async function markFromError(brandId, err) {
  if (!(err instanceof BostaError)) {
    await markConnectionStatus(brandId, 'error', err.message);
    return;
  }
  if (err.kind === 'rate_limited') return; // transient — backoff already handled it
  const status = err.kind === 'invalid' ? 'invalid' : err.kind === 'ip_blocked' ? 'ip_blocked' : 'error';
  await markConnectionStatus(brandId, status, err.message);
}

/** Advance the poll cursor. Only ever moves forward. */
async function updatePollCursor(brandId, cursorIso) {
  const patch = { last_poll_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (cursorIso) patch.last_poll_cursor = cursorIso;

  const { error } = await supabase.from('ivy_bosta_credentials').update(patch).eq('brand_id', brandId);
  if (error) console.error(`[bosta] failed to update poll cursor for ${brandId}: ${error.message}`);
}

/** Write historical-sync progress for the onboarding UI to poll. */
async function setHistoricalSyncState(brandId, state) {
  const patch = { historical_sync_state: state, updated_at: new Date().toISOString() };
  if (state?.status === 'done') patch.historical_sync_completed_at = new Date().toISOString();

  const { error } = await supabase.from('ivy_bosta_credentials').update(patch).eq('brand_id', brandId);
  if (error) console.error(`[bosta] failed to write sync state for ${brandId}: ${error.message}`);
}

/** Remove a brand's Bosta connection. Deliveries/events are kept for history. */
async function deleteCredentials(brandId) {
  const { error } = await supabase.from('ivy_bosta_credentials').delete().eq('brand_id', brandId);
  if (error) throw new Error(`ivy_bosta_credentials delete failed: ${error.message}`);
}

module.exports = {
  getCredentials,
  listPollableBrands,
  saveCredentials,
  markConnectionStatus,
  markFromError,
  updatePollCursor,
  setHistoricalSyncState,
  deleteCredentials,
};
