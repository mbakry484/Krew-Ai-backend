// =============================================================================
// SECRET ENCRYPTION AT REST (AES-256-GCM)
// =============================================================================
// Third-party credentials (Shopify/Meta tokens, Bosta API keys) are stored
// encrypted so a database dump alone can't be replayed against those APIs.
//
// Ciphertext format — a single self-describing string, safe in a text column:
//
//   v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
//
// The "v1" prefix is what makes this deployable without a flag day:
//
//   decryptSecret() returns any NON-prefixed value UNCHANGED.
//
// So plaintext rows keep working after this code ships, and the backfill can
// run later (or never, for a given row). The asymmetry matters — a write site
// that forgets to encrypt is harmless (it stores plaintext, which still reads
// back), but a read site that forgets to decrypt hands ciphertext to Shopify
// and breaks a live merchant. When in doubt, wrap the read.
//
// KREW_ENCRYPTION_KEY: 32 bytes, hex (64 chars) or base64. Generate with
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// If the key is UNSET, encryptSecret() is a pass-through and logs once at
// startup. That keeps dev/CI working without ceremony. It also means prod
// silently stores plaintext if the var is missing, so isEncryptionEnabled() is
// surfaced on /health rather than left to be discovered later.
//
// ⚠️ Losing/rotating KREW_ENCRYPTION_KEY makes every encrypted row
// undecryptable — every brand must reconnect Shopify/Meta/Bosta. Back it up
// where the rest of the prod secrets live.
// =============================================================================

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';
const IV_BYTES = 12; // 96-bit nonce — the GCM standard
const KEY_BYTES = 32;

let cachedKey; // undefined = not yet resolved, null = no key configured

/** Parse KREW_ENCRYPTION_KEY (hex or base64) into a 32-byte buffer, once. */
function getKey() {
  if (cachedKey !== undefined) return cachedKey;

  const raw = (process.env.KREW_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    console.warn(
      '⚠️ KREW_ENCRYPTION_KEY is not set — third-party credentials will be stored in PLAINTEXT. ' +
      'Set it to 32 random bytes (hex or base64) to enable encryption at rest.'
    );
    cachedKey = null;
    return cachedKey;
  }

  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
    try {
      const b64 = Buffer.from(raw, 'base64');
      if (b64.length === KEY_BYTES) buf = b64;
    } catch {
      buf = null;
    }
  }

  // A bad key is a hard failure, never a silent downgrade to plaintext: that
  // would encrypt nothing while looking configured.
  if (!buf || buf.length !== KEY_BYTES) {
    throw new Error(
      `KREW_ENCRYPTION_KEY must be ${KEY_BYTES} bytes as hex (64 chars) or base64 — got ${buf ? buf.length : '?'} bytes.`
    );
  }

  cachedKey = buf;
  return cachedKey;
}

/** True when a valid key is configured and values will actually be encrypted. */
function isEncryptionEnabled() {
  return getKey() !== null;
}

/** True if `value` is already in our ciphertext envelope. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

/**
 * Encrypt a secret for storage. Returns the value unchanged when it's empty,
 * already encrypted (idempotent — safe to re-run a backfill), or when no key
 * is configured.
 */
function encryptSecret(plain) {
  if (plain == null || plain === '') return plain;
  if (typeof plain !== 'string') plain = String(plain);
  if (isEncrypted(plain)) return plain;

  const key = getKey();
  if (!key) return plain;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypt a stored secret. Non-prefixed values (legacy plaintext) are returned
 * as-is, which is what lets encrypted and plaintext rows coexist.
 * Throws if a value IS encrypted but can't be decrypted — a wrong/missing key
 * must be loud, not a mystery 401 from Shopify later.
 */
function decryptSecret(stored) {
  if (stored == null || stored === '') return stored;
  if (typeof stored !== 'string') return stored;
  if (!isEncrypted(stored)) return stored; // legacy plaintext — pass through

  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new Error('Malformed encrypted secret: expected v1:<iv>:<tag>:<ciphertext>');
  }
  const [, ivB64, tagB64, dataB64] = parts;

  const key = getKey();
  if (!key) {
    throw new Error(
      'Found an encrypted secret but KREW_ENCRYPTION_KEY is not set — cannot decrypt. ' +
      'Restore the key that was used to write these rows.'
    );
  }

  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    // GCM auth failure = wrong key or tampered row. Never leak the payload.
    throw new Error(`Failed to decrypt secret (wrong KREW_ENCRYPTION_KEY or corrupted value): ${err.message}`);
  }
}

/**
 * Return a copy of `row` with the named secret fields decrypted.
 * Convenience for the many places that read a whole integrations/brands row —
 * `decryptRow(row, SECRET_FIELDS)` is harder to get subtly wrong than
 * decrypting each field by hand at 40-odd call sites.
 * Null/absent rows pass through so callers can stay one-liners.
 */
function decryptRow(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (out[f] != null) out[f] = decryptSecret(out[f]);
  }
  return out;
}

/** Every column in this codebase that holds a third-party credential. */
const SECRET_FIELDS = ['access_token', 'refresh_token', 'page_access_token', 'long_lived_user_token'];

module.exports = {
  encryptSecret,
  decryptSecret,
  decryptRow,
  isEncrypted,
  isEncryptionEnabled,
  SECRET_FIELDS,
};
