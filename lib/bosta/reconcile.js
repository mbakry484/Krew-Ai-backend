// =============================================================================
// BOSTA — payout reconciliation
// =============================================================================
// Bosta pays merchants weekly (COD minus fees), not per delivery. The two
// layers stay strictly separate:
//
//   PROFIT layer — revenue is counted at first_delivered_at. Immediate.
//   CASH layer   — nothing hits a pool until the founder logs the real payout
//                  ("Bosta paid me 340k to Bank on Sunday").
//
// This module bridges them for the founder's eye only: it computes what Bosta
// SHOULD pay for a period and shows it against what was actually logged. It
// never writes to a pool — auto-crediting cash from an estimate is exactly the
// kind of invented money the two-layer split exists to prevent.
//
//   expected_payout = Σ delivered COD − Σ shipment fees − Σ returned COD
//
// Bosta's wallet/payouts endpoint isn't in the public spec. If they expose one,
// auto-pulling actual payouts becomes v2 and this becomes a real reconciliation
// rather than an estimate.
// =============================================================================

const supabase = require('../supabase');

const round2 = (n) => Math.round(n * 100) / 100;

/** Sunday 00:00 → Sunday 00:00 window containing `ref`, in UTC. */
function weekWindow(ref = new Date()) {
  const end = new Date(ref);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - end.getUTCDay()); // back to Sunday
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * Expected vs logged payout for one period.
 *
 * @returns {Promise<{
 *   from: string, to: string,
 *   delivered_cod: number, shipment_fees: number, returned_cod: number,
 *   expected_payout: number, logged_payouts: number, variance: number,
 *   delivered_orders: number, returned_orders: number, logged_count: number,
 *   fees_missing_orders: number
 * }>}
 */
async function getPayoutReconciliation(brandId, { from, to } = {}) {
  const window = from && to ? { from, to } : weekWindow();

  // COD collected on deliveries in-window. cod_collected is what Bosta actually
  // took at the door — NOT delivered_value, which prefers goodsInfo.amount and
  // so excludes the shipping the customer paid. Payout maths must use the cash.
  const { data: delivered, error: deliveredError } = await supabase
    .from('ivy_orders')
    .select('cod_collected, delivered_value, shipment_fees')
    .eq('brand_id', brandId)
    .gte('delivered_at', window.from)
    .lt('delivered_at', window.to);
  if (deliveredError) throw new Error(`ivy_orders delivered read failed: ${deliveredError.message}`);

  const { data: returned, error: returnedError } = await supabase
    .from('ivy_orders')
    .select('returned_value, cod_collected')
    .eq('brand_id', brandId)
    .gte('returned_at', window.from)
    .lt('returned_at', window.to);
  if (returnedError) throw new Error(`ivy_orders returned read failed: ${returnedError.message}`);

  let deliveredCod = 0;
  let fees = 0;
  let feesMissing = 0;
  for (const o of delivered || []) {
    // Fall back to delivered_value when Bosta sent no COD figure (a prepaid or
    // zero-COD delivery still has item value but collects nothing at the door).
    const cod = Number(o.cod_collected) || 0;
    deliveredCod += cod > 0 ? cod : Number(o.delivered_value) || 0;
    const fee = Number(o.shipment_fees) || 0;
    fees += fee;
    if (fee === 0) feesMissing += 1;
  }

  const returnedCod = (returned || []).reduce((s, o) => s + (Number(o.returned_value) || 0), 0);

  // What the founder actually logged landing in a pool this period.
  const { data: payouts, error: payoutError } = await supabase
    .from('ivy_pool_transactions')
    .select('amount')
    .eq('brand_id', brandId)
    .eq('type', 'injection')
    .gte('occurred_at', window.from)
    .lt('occurred_at', window.to);
  if (payoutError) throw new Error(`ivy_pool_transactions read failed: ${payoutError.message}`);

  const logged = (payouts || []).reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const expected = deliveredCod - fees - returnedCod;

  return {
    from: window.from,
    to: window.to,
    delivered_cod: round2(deliveredCod),
    shipment_fees: round2(fees),
    returned_cod: round2(returnedCod),
    expected_payout: round2(expected),
    logged_payouts: round2(logged),
    variance: round2(logged - expected),
    delivered_orders: (delivered || []).length,
    returned_orders: (returned || []).length,
    logged_count: (payouts || []).length,
    // Every injection is counted as a payout — pools also get personal top-ups,
    // so a positive variance isn't necessarily a Bosta overpayment.
    fees_missing_orders: feesMissing,
  };
}

module.exports = { getPayoutReconciliation, weekWindow };
