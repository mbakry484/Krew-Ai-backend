// =============================================================================
// IVY — COGS engine (profit layer)
// =============================================================================
// Driven by delivery/return events from the Bosta pipeline (routes/bosta.js).
//
//   delivered → persist the order + its line items (fetched from Shopify by
//               order number if not already stored), book revenue at the COD /
//               order total, and book COGS = Σ qty × unit cost effective at
//               delivery time. Costs are SNAPSHOTTED onto the lines so later
//               cost changes never rewrite a booked month.
//   returned  → reverse revenue and COGS proportionally to returned units,
//               attributed at return time (a January delivery returned in
//               February hits each month correctly). v1 treats a return event
//               without per-line detail as a full package return (COD reality).
//
// A line with no known unit cost contributes 0 to COGS and flags the order
// cogs_incomplete = true — surfaced as cost coverage on the overview.
// =============================================================================

const supabase = require('../supabase');
const { getValidAccessToken, getShopifyOrderByNumber } = require('../shopify');
const { getLatestCosts } = require('./costs');
const { bareVariantId } = require('./variants');

const round2 = (n) => Math.round(n * 100) / 100;

/** "#1005" | "1005" → "1005" */
function normalizeOrderNumber(orderNumber) {
  return String(orderNumber || '').replace(/^#/, '').trim();
}

/**
 * Find-or-create the ivy_orders row for (brand, orderNumber), persisting line
 * items from Shopify on first sight. Returns { order, lines } or null when the
 * order can't be resolved against Shopify.
 */
async function ensureOrderWithLines(brandId, orderNumber, { trackingNumber = null } = {}) {
  const number = normalizeOrderNumber(orderNumber);
  if (!number) return null;

  const { data: existing, error } = await supabase
    .from('ivy_orders')
    .select('*')
    .eq('brand_id', brandId)
    .eq('order_number', number)
    .maybeSingle();
  if (error) throw new Error(`ivy_orders read failed: ${error.message}`);

  if (existing) {
    const { data: lines } = await supabase
      .from('ivy_order_lines')
      .select('*')
      .eq('order_id', existing.id);
    return { order: existing, lines: lines || [] };
  }

  // First sight of this order — pull it from Shopify to persist the lines.
  const { data: integration } = await supabase
    .from('integrations')
    .select('*')
    .eq('brand_id', brandId)
    .eq('platform', 'shopify')
    .maybeSingle();
  if (!integration) {
    console.error(`[ivy-cogs] no Shopify integration for brand ${brandId} — cannot resolve order #${number}`);
    return null;
  }

  const accessToken = await getValidAccessToken(integration);
  const shopifyOrder = await getShopifyOrderByNumber(integration.shopify_shop_domain, accessToken, number);
  if (!shopifyOrder) {
    console.error(`[ivy-cogs] order #${number} not found on Shopify for brand ${brandId}`);
    return null;
  }

  const { data: order, error: insertError } = await supabase
    .from('ivy_orders')
    .insert({
      brand_id: brandId,
      shopify_order_id: shopifyOrder.shopify_id,
      order_number: number,
      bosta_tracking_number: trackingNumber,
    })
    .select('*')
    .single();
  if (insertError) {
    // Concurrent webhook deliveries can race on the unique key — re-read.
    if (insertError.code === '23505') return ensureOrderWithLines(brandId, number, { trackingNumber });
    throw new Error(`ivy_orders insert failed: ${insertError.message}`);
  }

  const lineRows = (shopifyOrder.line_items || [])
    .filter((li) => li.variant_id)
    .map((li) => ({
      order_id: order.id,
      brand_id: brandId,
      variant_id: bareVariantId(li.variant_id),
      qty: li.quantity,
      unit_price: li.unit_price || 0,
    }));

  let lines = [];
  if (lineRows.length > 0) {
    const { data, error: linesError } = await supabase
      .from('ivy_order_lines')
      .insert(lineRows)
      .select('*');
    if (linesError) throw new Error(`ivy_order_lines insert failed: ${linesError.message}`);
    lines = data || [];
  }

  return { order: { ...order, shopify_total: shopifyOrder.total_price }, lines };
}

/**
 * Book a delivery: revenue at codAmount (falling back to the Shopify order
 * total / Σ line prices) and COGS at the costs effective now. Idempotent — a
 * re-delivered webhook for an already-delivered order is a no-op.
 */
async function recordDelivery(brandId, orderNumber, { codAmount = null, trackingNumber = null, deliveredAt = null } = {}) {
  const resolved = await ensureOrderWithLines(brandId, orderNumber, { trackingNumber });
  if (!resolved) return { ok: false, error: 'order_not_resolved' };
  const { order, lines } = resolved;

  if (order.status !== 'pending') {
    return { ok: true, skipped: 'already_processed', order_id: order.id };
  }

  const at = deliveredAt || new Date().toISOString();
  const costs = await getLatestCosts(brandId, at);

  let cogs = 0;
  let incomplete = false;
  const lineUpdates = [];
  for (const line of lines) {
    const cost = costs.get(line.variant_id);
    if (cost) {
      cogs += line.qty * cost.unit_cost;
      lineUpdates.push({ id: line.id, unit_cost_at_delivery: cost.unit_cost });
    } else {
      incomplete = true; // missing cost → contributes 0, order flagged
    }
  }
  if (lines.length === 0) incomplete = true;

  const linesTotal = lines.reduce((s, l) => s + l.qty * Number(l.unit_price), 0);
  const deliveredValue = Number(codAmount) > 0
    ? Number(codAmount)
    : (Number(order.shopify_total) > 0 ? Number(order.shopify_total) : linesTotal);

  for (const u of lineUpdates) {
    await supabase.from('ivy_order_lines').update({ unit_cost_at_delivery: u.unit_cost_at_delivery }).eq('id', u.id);
  }

  const { error } = await supabase
    .from('ivy_orders')
    .update({
      status: 'delivered',
      delivered_at: at,
      delivered_value: round2(deliveredValue),
      cogs_delivered: round2(cogs),
      cogs_incomplete: incomplete,
      bosta_tracking_number: trackingNumber || order.bosta_tracking_number,
    })
    .eq('id', order.id)
    .eq('status', 'pending'); // idempotency guard against concurrent events
  if (error) throw new Error(`ivy_orders delivery update failed: ${error.message}`);

  return { ok: true, order_id: order.id, cogs: round2(cogs), delivered_value: round2(deliveredValue), cogs_incomplete: incomplete };
}

/**
 * Reverse a delivered order on return. `returnedLines` ([{variantId, qty}])
 * enables partial reversal; omitted → full package return. Reversal uses the
 * cost snapshot taken at delivery, never today's cost.
 */
async function recordReturn(brandId, orderNumber, { returnedLines = null, returnedAt = null } = {}) {
  const number = normalizeOrderNumber(orderNumber);
  const { data: order } = await supabase
    .from('ivy_orders')
    .select('*')
    .eq('brand_id', brandId)
    .eq('order_number', number)
    .maybeSingle();
  if (!order) return { ok: false, error: 'order_not_found' };
  if (order.status === 'returned') return { ok: true, skipped: 'already_returned', order_id: order.id };
  if (order.status === 'pending') {
    // Returned without a recorded delivery (e.g. webhook gap) — nothing was
    // booked, so there is nothing to reverse. Mark it so it doesn't linger.
    await supabase.from('ivy_orders').update({ status: 'returned', returned_at: returnedAt || new Date().toISOString() }).eq('id', order.id);
    return { ok: true, skipped: 'returned_before_delivery', order_id: order.id };
  }

  const { data: lines } = await supabase
    .from('ivy_order_lines')
    .select('*')
    .eq('order_id', order.id);

  const wanted = returnedLines
    ? new Map(returnedLines.map((r) => [bareVariantId(r.variantId), r.qty]))
    : null;

  let unitsReturned = 0;
  let valueReversed = 0;
  let cogsReversed = 0;
  let unitsRemaining = 0;

  for (const line of lines || []) {
    const returnable = line.qty - line.returned_qty;
    const qty = wanted
      ? Math.min(returnable, Math.max(0, Number(wanted.get(line.variant_id)) || 0))
      : returnable; // full return
    if (qty > 0) {
      unitsReturned += qty;
      valueReversed += qty * Number(line.unit_price);
      if (line.unit_cost_at_delivery != null) cogsReversed += qty * Number(line.unit_cost_at_delivery);
      await supabase
        .from('ivy_order_lines')
        .update({ returned_qty: line.returned_qty + qty })
        .eq('id', line.id);
    }
    unitsRemaining += returnable - qty;
  }

  if (unitsReturned === 0 && lines && lines.length > 0) {
    return { ok: true, skipped: 'nothing_to_return', order_id: order.id };
  }

  // A full return of an order whose delivered_value came from COD (which can
  // differ from Σ line prices by shipping) reverses the full delivered value.
  const fullReturn = unitsRemaining === 0;
  if (fullReturn) valueReversed = Number(order.delivered_value) - Number(order.returned_value);

  const at = returnedAt || new Date().toISOString();
  const { error } = await supabase
    .from('ivy_orders')
    .update({
      status: fullReturn ? 'returned' : 'partially_returned',
      returned_at: at,
      returned_value: round2(Number(order.returned_value) + valueReversed),
      cogs_reversed: round2(Number(order.cogs_reversed) + cogsReversed),
    })
    .eq('id', order.id);
  if (error) throw new Error(`ivy_orders return update failed: ${error.message}`);

  return { ok: true, order_id: order.id, units_returned: unitsReturned, value_reversed: round2(valueReversed), cogs_reversed: round2(cogsReversed) };
}

module.exports = { recordDelivery, recordReturn, ensureOrderWithLines, normalizeOrderNumber };
