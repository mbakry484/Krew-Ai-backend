// =============================================================================
// IVY — profit layer read model (wraps the ivy_profit_summary RPC)
// =============================================================================

const supabase = require('../supabase');

/** 'this_month' | 'last_month' | 'last_90' | 'last_7' → { from, to } ISO (UTC months). */
function periodRange(period = 'this_month') {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case 'last_month':
      return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
    case 'last_90':
      return { from: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    case 'last_7':
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    case 'this_month':
    default:
      return { from: new Date(Date.UTC(y, m, 1)).toISOString(), to: new Date(Date.UTC(y, m + 1, 1)).toISOString() };
  }
}

/**
 * Real P&L for a brand and period. Numbers, not strings:
 * { net_revenue, gross_delivered, returns, return_rate_pct, cogs,
 *   cogs_incomplete_orders, opex, inventory_spend, real_net_profit,
 *   cash_delta, cost_coverage_pct }
 */
async function getProfitSummary(brandId, period = 'this_month') {
  const { from, to } = periodRange(period);
  const { data, error } = await supabase.rpc('ivy_profit_summary', {
    p_brand_id: brandId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`ivy_profit_summary failed: ${error.message}`);
  const out = {};
  for (const [k, v] of Object.entries(data || {})) out[k] = typeof v === 'string' ? Number(v) : v;
  return { period, from, to, ...out };
}

module.exports = { getProfitSummary, periodRange };
