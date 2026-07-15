// =============================================================================
// IVY — Telegram report (the one long message Ivy sends, fixed skeleton)
// =============================================================================
//   📊 **week in numbers**
//   net revenue: **EGP 142,000** (delivered − returns)
//   COGS: **EGP 51,000** · expenses: **EGP 46,000**
//   real profit: **EGP 45,000**
//   cash: **+EGP 12,000** across pools
//   returns: **24%** — steady
//   one thing: <a genuine insight from the data — mandatory, never a platitude>
//
// The "one thing" line is computed from real data through an ordered rule list
// (concentration risk → best-seller stock → return trend → cost coverage →
// dead stock → margin), so it is always grounded, never generated.
// =============================================================================

const supabase = require('../supabase');
const { getProfitSummary } = require('./profit');
const { explodeVariants } = require('./variants');
const { getProductStats } = require('./stats');

const egp = (n) => `EGP ${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-US')}`;

const HEADERS = {
  last_7: 'week in numbers',
  this_month: 'month in numbers',
  last_month: 'last month in numbers',
  last_90: 'last 90 days in numbers',
};

// Baseline period used for the returns trend word.
const BASELINE = {
  last_7: 'prev_7',
  this_month: 'last_month',
  last_month: 'prev_month',
};

const CONCENTRATION_PCT = 60;
const LOW_STOCK_DAYS = 7;
const DEAD_STOCK_DAYS = 60;
const RETURN_TREND_PTS = 3;
const RETURN_SPIKE_PTS = 5;

const variantName = (v) =>
  v.variantTitle && v.variantTitle !== 'Default Title'
    ? `${v.productTitle} ${v.variantTitle}`
    : v.productTitle || `variant ${v.variantId}`;

/** returns line suffix: "steady" | "up from 21%" | "down from 27%". */
function returnsTrend(currentPct, baselinePct) {
  if (baselinePct == null) return '';
  const delta = currentPct - baselinePct;
  if (Math.abs(delta) < RETURN_TREND_PTS) return ' — steady';
  return delta > 0
    ? ` — up from ${baselinePct.toFixed(0)}%, worth watching`
    : ` — down from ${baselinePct.toFixed(0)}%`;
}

/**
 * The mandatory closing insight. Walks an ordered rule list and returns the
 * first one the data actually supports.
 */
async function computeOneThing(brandId, summary, baseline) {
  try {
    const [{ data: products }, stats] = await Promise.all([
      supabase.from('products').select('name, variants').eq('brand_id', brandId),
      getProductStats(brandId),
    ]);
    const variants = explodeVariants(products || []);
    const rows = variants.map((v) => ({ v, s: stats.get(v.variantId) })).filter((r) => r.s);

    // 1. Concentration risk: one variant carrying most of the revenue.
    const totalRevenue = rows.reduce((sum, r) => sum + Number(r.s.revenue_30d), 0);
    if (totalRevenue > 0) {
      const top = rows.reduce((a, b) => (Number(a.s.revenue_30d) >= Number(b.s.revenue_30d) ? a : b));
      const share = (Number(top.s.revenue_30d) / totalRevenue) * 100;
      if (share >= CONCENTRATION_PCT) {
        return `**${variantName(top.v)}** is ${Math.round(share)}% of revenue. great — and fragile. worth building a second horse.`;
      }
    }

    // 2. A best seller close to selling out.
    for (const { v, s } of rows) {
      const velocity = Number(s.velocity_30d);
      if (!s.is_best_seller || velocity <= 0 || v.unitsInStock <= 0) continue;
      const days = v.unitsInStock / velocity;
      if (days < LOW_STOCK_DAYS) {
        return `**${variantName(v)}** is a best seller with ~${Math.max(1, Math.round(days))} days of stock left — restock now or leave money on the table.`;
      }
    }

    // 3. Return rate moved sharply vs the baseline period.
    if (baseline && baseline.gross_delivered > 0 && summary.gross_delivered > 0) {
      const delta = Number(summary.return_rate_pct) - Number(baseline.return_rate_pct);
      if (delta >= RETURN_SPIKE_PTS) {
        return `returns hit ${Number(summary.return_rate_pct).toFixed(0)}%, up from ${Number(baseline.return_rate_pct).toFixed(0)}% — that's **${egp(summary.returns)}** coming back. check if it's one product or one courier zone.`;
      }
    }

    // 4. Profit accuracy is off because costs are missing.
    if (Number(summary.cogs_incomplete_orders) > 0) {
      return `${summary.cogs_incomplete_orders} delivered order(s) are missing unit costs — real profit above is overstated. fill in costs and I'll stop guessing.`;
    }

    // 5. Money sitting still in dead stock.
    let deadest = null;
    for (const { v, s } of rows) {
      if (v.unitsInStock <= 0 || !s.last_sale_at) continue;
      const daysSince = (Date.now() - new Date(s.last_sale_at).getTime()) / 86400000;
      if (daysSince <= DEAD_STOCK_DAYS) continue;
      const unitValue = v.shopifyUnitCost != null ? v.shopifyUnitCost : v.sellingPrice;
      const value = v.unitsInStock * unitValue;
      if (!deadest || value > deadest.value) deadest = { v, daysSince, value };
    }
    if (deadest) {
      return `**${variantName(deadest.v)}** hasn't sold in ${Math.round(deadest.daysSince)} days — **${egp(deadest.value)}** sitting still. flash sale or bundle?`;
    }

    // 6. Fallback: the margin, stated plainly.
    if (Number(summary.net_revenue) > 0) {
      const margin = (Number(summary.real_net_profit) / Number(summary.net_revenue)) * 100;
      return `you kept ${margin.toFixed(0)} piasters of every pound of net revenue this period.`;
    }
  } catch (err) {
    console.error('[ivy-report] one-thing computation failed:', err.message);
  }
  return `no deliveries booked this period — once orders start moving I'll have more to say.`;
}

/** Build the full fixed-skeleton report for one brand and period. */
async function buildReportMessage(brandId, period = 'last_7') {
  const baselinePeriod = BASELINE[period] || null;
  const [summary, baseline] = await Promise.all([
    getProfitSummary(brandId, period),
    baselinePeriod
      ? getProfitSummary(brandId, baselinePeriod).catch(() => null)
      : Promise.resolve(null),
  ]);

  const profit = Number(summary.real_net_profit) || 0;
  const cash = Number(summary.cash_delta) || 0;
  const returnRate = Number(summary.return_rate_pct) || 0;
  const baselineRate = baseline && Number(baseline.gross_delivered) > 0 ? Number(baseline.return_rate_pct) : null;

  const lines = [
    `📊 **${HEADERS[period] || HEADERS.last_7}**`,
    `net revenue: **${egp(summary.net_revenue)}** (delivered − returns)`,
    `COGS: **${egp(summary.cogs)}** · expenses: **${egp(summary.opex)}**`,
    `real profit: **${profit < 0 ? '−' : ''}${egp(profit)}**`,
    `cash: **${cash < 0 ? '−' : '+'}${egp(cash)}** across pools`,
    `returns: **${returnRate.toFixed(0)}%**${returnsTrend(returnRate, baselineRate)}`,
    `one thing: ${await computeOneThing(brandId, summary, baseline)}`,
  ];
  return lines.join('\n');
}

module.exports = { buildReportMessage };
