const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { recordDelivery, recordReturn } = require('../lib/ivy/cogs');

// =============================================================================
// BOSTA WEBHOOK — delivery/return events → Ivy's profit layer
// =============================================================================
// Bosta (the COD courier) is the revenue source of truth: an order counts as
// revenue when DELIVERED and reverses when RETURNED. Configure the webhook in
// the Bosta business dashboard per brand as:
//
//   https://<host>/webhook/bosta/<brand_id>?secret=<BOSTA_WEBHOOK_SECRET>
//
// The brand id is in the path because Bosta payloads don't carry it; the
// shared secret (env BOSTA_WEBHOOK_SECRET) gates the endpoint. The Shopify
// order number MUST be set as the Bosta businessReference when the shipment is
// created — that is how a Bosta delivery is matched back to its Shopify order
// and line items.
//
// Payload parsing is deliberately tolerant: Bosta has shipped both flat and
// nested ("_id"/"state.value"/"specs") shapes across API versions.
// =============================================================================

/** Extract what we need from a Bosta webhook body, tolerating shape drift. */
function parseBostaPayload(body = {}) {
  const stateRaw = body.state?.value || body.state?.state || body.state || body.deliveryState || '';
  const state = String(stateRaw).toLowerCase();

  const orderNumber =
    body.businessReference || body.business_reference ||
    body.specs?.packageDetails?.businessReference || body.orderReference || null;

  const trackingNumber = body.trackingNumber || body.tracking_number || body._id || null;

  const codRaw = body.cod ?? body.codAmount ?? body.cod_amount ?? body.specs?.cod ?? null;
  const codAmount = codRaw != null && Number.isFinite(Number(codRaw)) ? Number(codRaw) : null;

  const occurredAt = body.timestamp || body.updatedAt || body.updated_at || null;

  let event = null;
  if (state.includes('deliver') && !state.includes('out for')) event = 'delivered';
  // "Returned to business" / "Returned" / state code 46-style strings
  if (state.includes('return')) event = 'returned';

  return { event, state, orderNumber, trackingNumber, codAmount, occurredAt };
}

router.post('/:brandId', async (req, res) => {
  const secret = process.env.BOSTA_WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret && req.headers['x-bosta-secret'] !== secret) {
    return res.sendStatus(401);
  }

  const { brandId } = req.params;
  // Ack immediately — couriers retry aggressively on slow responses, and the
  // Shopify order lookup below can take a few seconds.
  res.json({ received: true });

  try {
    const { data: brand } = await supabase.from('brands').select('id').eq('id', brandId).maybeSingle();
    if (!brand) {
      console.error(`[bosta] webhook for unknown brand ${brandId} — dropping`);
      return;
    }

    const parsed = parseBostaPayload(req.body);
    if (!parsed.event) return; // intermediate state (picked up, in transit, …) — not a revenue event
    if (!parsed.orderNumber) {
      console.error(`[bosta] ${parsed.event} event for brand ${brandId} has no businessReference — cannot match a Shopify order (tracking: ${parsed.trackingNumber})`);
      return;
    }

    const result = parsed.event === 'delivered'
      ? await recordDelivery(brandId, parsed.orderNumber, {
          codAmount: parsed.codAmount,
          trackingNumber: parsed.trackingNumber,
          deliveredAt: parsed.occurredAt,
        })
      : await recordReturn(brandId, parsed.orderNumber, { returnedAt: parsed.occurredAt });

    if (!result.ok) {
      console.error(`[bosta] ${parsed.event} for order #${parsed.orderNumber} (brand ${brandId}) failed: ${result.error}`);
    } else if (!result.skipped) {
      console.log(`[bosta] ${parsed.event} booked for order #${parsed.orderNumber} (brand ${brandId})`);
    }
  } catch (err) {
    console.error('[bosta] webhook processing error:', err.message);
  }
});

module.exports = router;
