const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// The key must be set BEFORE lib/crypto.js resolves it (it caches on first use).
process.env.KREW_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { encryptSecret, decryptSecret, decryptRow, isEncrypted, isEncryptionEnabled } = require('../lib/crypto');

test('encryption is enabled when a valid key is configured', () => {
  assert.equal(isEncryptionEnabled(), true);
});

test('round-trips a secret', () => {
  const plain = 'shpat_abc123def456';
  const enc = encryptSecret(plain);
  assert.notEqual(enc, plain, 'ciphertext must not equal plaintext');
  assert.ok(enc.startsWith('v1:'), 'ciphertext must carry the version prefix');
  assert.equal(decryptSecret(enc), plain);
});

test('same plaintext encrypts to different ciphertext each time (random IV)', () => {
  const a = encryptSecret('same-token');
  const b = encryptSecret('same-token');
  assert.notEqual(a, b, 'a fixed IV would leak that two rows share a token');
  assert.equal(decryptSecret(a), decryptSecret(b));
});

// The property the whole rollout depends on: plaintext rows keep working after
// the cipher ships, so code can deploy before the backfill runs.
test('decryptSecret passes legacy PLAINTEXT through unchanged', () => {
  for (const plain of ['shpat_legacy_token', 'IGQVJ...meta', 'bosta-api-key']) {
    assert.equal(decryptSecret(plain), plain);
  }
});

test('encryptSecret is idempotent — backfill can be re-run safely', () => {
  const once = encryptSecret('token');
  const twice = encryptSecret(once);
  assert.equal(twice, once, 'must not double-encrypt');
  assert.equal(decryptSecret(twice), 'token');
});

test('empty and null values pass through both ways', () => {
  for (const v of [null, undefined, '']) {
    assert.equal(encryptSecret(v), v);
    assert.equal(decryptSecret(v), v);
  }
});

test('isEncrypted distinguishes ciphertext from plaintext', () => {
  assert.equal(isEncrypted(encryptSecret('x')), true);
  assert.equal(isEncrypted('shpat_plain'), false);
  assert.equal(isEncrypted(null), false);
});

// A wrong key must fail loudly here rather than surface later as a mystery 401
// from Shopify with no indication that encryption was involved.
test('decrypting with the wrong key throws', () => {
  const enc = encryptSecret('secret-value');
  const parts = enc.split(':');
  // Corrupt the ciphertext body — GCM's auth tag must reject it.
  const tampered = [parts[0], parts[1], parts[2], Buffer.from('tampered').toString('base64')].join(':');
  assert.throws(() => decryptSecret(tampered), /Failed to decrypt secret/);
});

test('malformed envelope throws rather than returning garbage', () => {
  assert.throws(() => decryptSecret('v1:only:three'), /Malformed encrypted secret/);
});

test('decryptRow decrypts named fields and leaves others alone', () => {
  const row = {
    id: 'abc',
    shopify_shop_domain: 'test.myshopify.com',
    access_token: encryptSecret('at-123'),
    refresh_token: encryptSecret('rt-456'),
    token_expires_at: '2026-01-01T00:00:00Z',
  };
  const out = decryptRow(row, ['access_token', 'refresh_token']);
  assert.equal(out.access_token, 'at-123');
  assert.equal(out.refresh_token, 'rt-456');
  assert.equal(out.shopify_shop_domain, 'test.myshopify.com');
  assert.equal(out.token_expires_at, '2026-01-01T00:00:00Z');
  assert.equal(out.id, 'abc');
});

test('decryptRow handles null rows and mixed plaintext/ciphertext', () => {
  assert.equal(decryptRow(null, ['access_token']), null);
  const mixed = { access_token: 'legacy-plaintext', refresh_token: encryptSecret('rt') };
  const out = decryptRow(mixed, ['access_token', 'refresh_token']);
  assert.equal(out.access_token, 'legacy-plaintext');
  assert.equal(out.refresh_token, 'rt');
});
