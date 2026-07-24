const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getCredentials } = require('../lib/bosta/credentials');
const { persistPage } = require('../lib/bosta/ingest');
const { processEvents } = require('../lib/bosta/processor');

// =============================================================================
// BOSTA WEBHOOK — SECONDARY ingestion path
// =============================================================================
// Mounted at /webhook/bosta/:brandId.
//
// Read this before assuming webhooks matter here: Ivy does NOT create
// deliveries — the founder ships via the Shopify-Bosta plugin or Bosta's
// dashboard. Bosta webhooks are registered PER DELIVERY at creation time, so we
// have no way to attach one to the founder's existing sales. Polling
// (lib/bosta/ingest.js, every 10 min) is the primary and only path that runs
// today.
//
// This endpoint exists so that IF a future Krew shipping flow creates
// deliveries — registering our URL plus an Authorization header via Bosta's
// webhookCustomHeaders — those events land cleanly without another deploy. The
// unique constraint on ivy_bosta_events dedupes whatever polling already caught,
// so the two paths are safely redundant rather than double-counting.
//
// Auth: `Authorization` header must match ivy_bosta_credentials.webhook_secret
// for the brand. A per-brand secret in a header beats the old global
// ?secret= query param — query strings land in access logs, and one shared
// env-var secret meant any brand's webhook could forge another's.
// =============================================================================

/** Constant-time compare that tolerates length mismatch without throwing. */
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post('/:brandId', async (req, res) => {
  const { brandId } = req.params;

  let cred;
  try {
    cred = await getCredentials(brandId);
  } catch (err) {
    console.error(`[bosta-webhook] credential lookup failed for ${brandId}: ${err.message}`);
    return res.sendStatus(500);
  }
  if (!cred) return res.sendStatus(404);

  // Accept a bare secret or "Bearer <secret>" — we control what we register, but
  // Bosta's header passthrough has not been exercised end-to-end.
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!secretMatches(provided, cred.webhook_secret)) {
    console.warn(`[bosta-webhook] rejected unauthorized webhook for brand ${brandId}`);
    return res.sendStatus(401);
  }

  // Ack immediately — couriers retry aggressively on slow responses, and the
  // Shopify order lookup downstream can take seconds.
  res.json({ received: true });

  try {
    // The payload matches the delivery detail shape, so it goes through exactly
    // the same normalize → upsert → event path as polling. No parallel parser to
    // drift out of sync.
    const body = req.body?.delivery || req.body?.data || req.body;
    const deliveries = Array.isArray(body) ? body : [body];

    const result = await persistPage(brandId, deliveries, { source: 'webhook' });
    if (result.events > 0) {
      console.log(`[bosta-webhook] brand ${brandId}: ${result.events} finance event(s) queued`);
      // Webhooks imply someone is watching — don't wait for the next cron tick.
      await processEvents({ limit: 20 });
    }
  } catch (err) {
    console.error(`[bosta-webhook] processing error for brand ${brandId}: ${err.message}`);
  }
});

module.exports = router;
