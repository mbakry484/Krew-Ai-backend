const crypto = require('crypto');

// Small allowance for clock drift between the app server and this backend.
const MAX_SKEW_SECONDS = 5;

/**
 * Verify the X-Krew-App-Auth header minted by the embedded Shopify app.
 *
 * Header format: base64url(payloadJSON).base64url(HMAC-SHA256(payloadB64))
 * Payload:       { shop, exp }   (exp = unix seconds)
 *
 * On success: sets req.shopDomain to the verified shop and calls next().
 * On any failure (missing/malformed/bad signature/expired): responds 401 and
 * does NOT call next().
 */
function verifyKrewAppAuth(req, res, next) {
  const secret = process.env.KREW_INTERNAL_SECRET;
  if (!secret) {
    console.error('KREW_INTERNAL_SECRET is not configured');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const header = req.get('X-Krew-App-Auth');
  if (typeof header !== 'string' || !header.includes('.')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const [payloadB64, sig] = header.split('.');
  if (!payloadB64 || !sig) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Verify the signature first, in constant time, before trusting any bytes.
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  let provided;
  try {
    provided = Buffer.from(sig, 'base64url');
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Signature valid — now parse and validate the payload.
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + MAX_SKEW_SECONDS < now) {
    return res.status(401).json({ error: 'token_expired' });
  }
  if (typeof payload.shop !== 'string' || !payload.shop) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  req.shopDomain = payload.shop;
  next();
}

module.exports = { verifyKrewAppAuth };
