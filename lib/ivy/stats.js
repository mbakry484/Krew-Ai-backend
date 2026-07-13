// =============================================================================
// IVY — nightly per-variant sales stats (velocity, best sellers)
// =============================================================================
// Output of step 1–2 of the nightly job: upserts ivy_product_stats per brand.
// Velocity/revenue use GROSS delivered units over the last 30 days (returns
// don't reliably restock, so they don't slow the sell-through signal).
// last_sale_at is all-time — the dead-stock rule needs to see past the window.
// =============================================================================

const supabase = require('../supabase');

const WINDOW_DAYS = 30;
const BEST_SELLER_TOP_SHARE = 0.2;
const BEST_SELLER_MIN_UNITS = 5;

async function computeProductStats(brandId) {
  const now = Date.now();
  const cutoff = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // All delivered lines (all-time) with their order's delivered_at; the 30d
  // window and last_sale_at both come out of one pass.
  const { data: lines, error } = await supabase
    .from('ivy_order_lines')
    .select('variant_id, qty, unit_price, ivy_orders!inner(delivered_at)')
    .eq('brand_id', brandId)
    .not('ivy_orders.delivered_at', 'is', null);
  if (error) throw new Error(`stats lines read failed: ${error.message}`);

  const perVariant = new Map(); // vid → {units30, revenue30, lastSaleAt}
  for (const line of lines || []) {
    const deliveredAt = line.ivy_orders?.delivered_at;
    if (!deliveredAt) continue;
    const agg = perVariant.get(line.variant_id) || { units30: 0, revenue30: 0, lastSaleAt: null };
    if (deliveredAt >= cutoff) {
      agg.units30 += line.qty;
      agg.revenue30 += line.qty * Number(line.unit_price);
    }
    if (!agg.lastSaleAt || deliveredAt > agg.lastSaleAt) agg.lastSaleAt = deliveredAt;
    perVariant.set(line.variant_id, agg);
  }

  if (perVariant.size === 0) return { variants: 0, bestSellers: 0 };

  // Best sellers: top 20% by 30d revenue among variants that moved ≥ 5 units.
  const ranked = [...perVariant.entries()].sort((a, b) => b[1].revenue30 - a[1].revenue30);
  const topN = Math.ceil(ranked.length * BEST_SELLER_TOP_SHARE);
  const bestSellers = new Set(
    ranked
      .slice(0, topN)
      .filter(([, agg]) => agg.units30 >= BEST_SELLER_MIN_UNITS)
      .map(([vid]) => vid)
  );

  const computedAt = new Date().toISOString();
  const rows = ranked.map(([vid, agg]) => ({
    brand_id: brandId,
    shopify_variant_id: vid,
    velocity_30d: Math.round((agg.units30 / WINDOW_DAYS) * 1000) / 1000,
    units_delivered_30d: agg.units30,
    revenue_30d: Math.round(agg.revenue30 * 100) / 100,
    is_best_seller: bestSellers.has(vid),
    last_sale_at: agg.lastSaleAt,
    computed_at: computedAt,
  }));

  const { error: upsertError } = await supabase
    .from('ivy_product_stats')
    .upsert(rows, { onConflict: 'brand_id,shopify_variant_id' });
  if (upsertError) throw new Error(`stats upsert failed: ${upsertError.message}`);

  return { variants: rows.length, bestSellers: bestSellers.size };
}

/** Stats rows for a brand as a Map<variantId, row>. */
async function getProductStats(brandId) {
  const { data, error } = await supabase
    .from('ivy_product_stats')
    .select('*')
    .eq('brand_id', brandId);
  if (error) throw new Error(`stats read failed: ${error.message}`);
  return new Map((data || []).map((r) => [r.shopify_variant_id, r]));
}

module.exports = { computeProductStats, getProductStats, WINDOW_DAYS };
