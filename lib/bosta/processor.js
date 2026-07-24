// =============================================================================
// BOSTA — event processor (single worker, every minute)
// =============================================================================
// Drains unprocessed ivy_bosta_events in occurred_at order and applies the
// finance effect through the EXISTING COGS engine (lib/ivy/cogs.js), which owns
// ivy_orders / ivy_order_lines and the cost snapshotting. This module resolves
// and dispatches; it never does money maths itself.
//
//   delivered → recordDelivery  (+revenue, +COGS at costs effective then)
//   returned  → recordReturn    (reverse both, at the delivery-time snapshot)
//   cancelled → recordReturn if it had been delivered; ignore if never delivered
//
// Ordering by occurred_at is what makes state corrections work: Bosta can move a
// delivery backwards, and replaying in event order lands on the current truth.
//
// Retry model: a failed event is left unprocessed and picked up next tick. Every
// effect is idempotent (recordDelivery no-ops on an already-delivered order,
// recordReturn on an already-returned one), so re-running is safe by design.
// =============================================================================

const supabase = require('../supabase');
const { recordDelivery, recordReturn } = require('../ivy/cogs');

const BATCH_SIZE = 200;
const MAX_ATTEMPTS = 5; // then park it — a poison event must not block the queue

/** Revenue for a delivery: prefer true item value over COD (which bundles shipping). */
function revenueOf(delivery) {
  const goods = Number(delivery.goods_amount);
  if (Number.isFinite(goods) && goods > 0) return goods;
  const cod = Number(delivery.cod_amount);
  return Number.isFinite(cod) && cod > 0 ? cod : null;
}

/** The Shopify order number a delivery claims, if any. */
function referenceOf(delivery) {
  return delivery.business_reference || delivery.unique_business_reference || null;
}

/**
 * Apply one event. Returns { ok, detail } — `ok: false` leaves it unprocessed
 * for retry.
 */
async function applyEvent(event) {
  const { data: delivery, error } = await supabase
    .from('ivy_deliveries')
    .select('*')
    .eq('brand_id', event.brand_id)
    .eq('bosta_delivery_id', event.bosta_delivery_id)
    .maybeSingle();
  if (error) return { ok: false, detail: `ivy_deliveries read failed: ${error.message}` };
  if (!delivery) return { ok: true, detail: 'delivery_row_missing' }; // nothing to act on

  const brandId = event.brand_id;
  const reference = referenceOf(delivery);
  const revenue = revenueOf(delivery);

  // No businessReference at all — the Shopify-Bosta plugin didn't set one, or
  // the delivery was created by hand in Bosta's dashboard. We still count the
  // cash (it's real), keyed by tracking number so it can't collide with a real
  // order number, and it surfaces in unmatched_bosta_deliveries for repair.
  const orderNumber = reference || (delivery.tracking_number ? `bosta-${delivery.tracking_number}` : null);
  if (!orderNumber) {
    return { ok: true, detail: 'no_reference_or_tracking' };
  }

  if (event.event_type === 'delivered') {
    const res = await recordDelivery(brandId, orderNumber, {
      codAmount: revenue,
      trackingNumber: delivery.tracking_number,
      deliveredAt: event.occurred_at,
      shipmentFees: delivery.shipment_fees,
      codCollected: delivery.cod_amount,
      allowWithoutShopify: true, // count the cash even if Shopify can't match it
    });
    if (!res.ok) return { ok: false, detail: res.error };

    await linkDeliveryToOrder(brandId, delivery, orderNumber, reference);
    return { ok: true, detail: res.skipped || `booked ${res.delivered_value} (cogs ${res.cogs}${res.cogs_incomplete ? ', incomplete' : ''})` };
  }

  if (event.event_type === 'returned') {
    // v1 treats a return as a full package return — COD reality, and Bosta's
    // payload carries no per-line detail. Partial returns are out of scope.
    const res = await recordReturn(brandId, orderNumber, { returnedAt: event.occurred_at });
    if (!res.ok && res.error !== 'order_not_found') return { ok: false, detail: res.error };
    return { ok: true, detail: res.skipped || res.error || `reversed ${res.value_reversed}` };
  }

  if (event.event_type === 'cancelled') {
    // Terminated: reverse only if it had actually been delivered. A cancellation
    // before delivery booked nothing, so there's nothing to undo.
    const { data: order } = await supabase
      .from('ivy_orders')
      .select('id, status')
      .eq('brand_id', brandId)
      .eq('order_number', String(orderNumber).replace(/^#/, '').trim())
      .maybeSingle();

    if (!order || order.status === 'pending') return { ok: true, detail: 'cancelled_before_delivery' };
    if (order.status === 'returned') return { ok: true, detail: 'already_reversed' };

    const res = await recordReturn(brandId, orderNumber, { returnedAt: event.occurred_at });
    if (!res.ok && res.error !== 'order_not_found') return { ok: false, detail: res.error };
    return { ok: true, detail: res.skipped || `cancelled, reversed ${res.value_reversed}` };
  }

  return { ok: true, detail: `ignored_event_type:${event.event_type}` };
}

/**
 * Record which Shopify order a delivery resolved to, and flag any reference
 * claimed by more than one brand (the doc's cross-brand collision check).
 * ivy_deliveries.order_number stays NULL when unmatched, which is what drives
 * the unmatched_bosta_deliveries view.
 */
async function linkDeliveryToOrder(brandId, delivery, orderNumber, reference) {
  if (!reference) return; // synthetic bosta-<tracking> key — genuinely unmatched

  const { data: order } = await supabase
    .from('ivy_orders')
    .select('id, shopify_order_id')
    .eq('brand_id', brandId)
    .eq('order_number', String(orderNumber).replace(/^#/, '').trim())
    .maybeSingle();

  // shopify_order_id is null when the order was booked unmatched — leave
  // order_number null so it stays visible in the repair view.
  if (!order?.shopify_order_id) return;

  await supabase
    .from('ivy_deliveries')
    .update({ order_number: orderNumber, shopify_order_id: order.shopify_order_id })
    .eq('brand_id', brandId)
    .eq('bosta_delivery_id', delivery.bosta_delivery_id);

  const { data: collisions } = await supabase
    .from('ivy_deliveries')
    .select('brand_id')
    .eq('business_reference', reference)
    .neq('brand_id', brandId)
    .limit(1);
  if (collisions && collisions.length > 0) {
    console.warn(
      `[bosta] businessReference "${reference}" appears under multiple brands (${brandId} and ${collisions[0].brand_id}) — revenue may be misattributed`
    );
  }
}

/** Drain one batch of unprocessed events. Safe to call on a tight interval. */
async function processEvents({ limit = BATCH_SIZE } = {}) {
  const { data: events, error } = await supabase
    .from('ivy_bosta_events')
    .select('*')
    .is('processed_at', null)
    .lt('attempts', MAX_ATTEMPTS)
    .order('occurred_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`ivy_bosta_events read failed: ${error.message}`);
  if (!events || events.length === 0) return { processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;

  for (const event of events) {
    let result;
    try {
      result = await applyEvent(event);
    } catch (err) {
      result = { ok: false, detail: err.message };
    }

    if (result.ok) {
      const { error: markError } = await supabase
        .from('ivy_bosta_events')
        .update({ processed_at: new Date().toISOString(), process_error: null })
        .eq('id', event.id);
      if (markError) console.error(`[bosta] failed to mark event ${event.id} processed: ${markError.message}`);
      processed += 1;
    } else {
      const attempts = (event.attempts || 0) + 1;
      await supabase
        .from('ivy_bosta_events')
        .update({ attempts, process_error: String(result.detail).slice(0, 500) })
        .eq('id', event.id);
      failed += 1;
      console.error(
        `[bosta] event ${event.id} (${event.event_type}, delivery ${event.bosta_delivery_id}) failed [attempt ${attempts}/${MAX_ATTEMPTS}]: ${result.detail}`
      );
      if (attempts >= MAX_ATTEMPTS) {
        console.error(`[bosta] event ${event.id} exhausted retries — parked. Inspect ivy_bosta_events.process_error.`);
      }
    }
  }

  if (processed > 0 || failed > 0) console.log(`[bosta-processor] ${processed} processed, ${failed} failed`);
  return { processed, failed };
}

module.exports = { processEvents, applyEvent, revenueOf, referenceOf, MAX_ATTEMPTS };
