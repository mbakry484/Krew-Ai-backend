// =============================================================================
// IVY — per-variant unit costs (append-only, manual wins over shopify)
// =============================================================================
// ivy_product_costs is append-only: a cost change INSERTS a row; the cost
// effective for an order is the latest row with effective_from <= the event
// time. A manual row permanently shadows Shopify sync values for that variant
// (the sync never inserts once a manual row exists).
// =============================================================================

const supabase = require('../supabase');
const { bareVariantId } = require('./variants');

/** Latest cost row per variant for a brand: Map<variantId, {unit_cost, source, effective_from}>. */
async function getLatestCosts(brandId, atTime = null) {
  let query = supabase
    .from('ivy_product_costs')
    .select('shopify_variant_id, unit_cost, source, effective_from')
    .eq('brand_id', brandId)
    .order('effective_from', { ascending: false });
  if (atTime) query = query.lte('effective_from', atTime);

  const { data, error } = await query;
  if (error) throw new Error(`ivy_product_costs read failed: ${error.message}`);

  const latest = new Map();
  for (const row of data || []) {
    if (!latest.has(row.shopify_variant_id)) {
      latest.set(row.shopify_variant_id, {
        unit_cost: Number(row.unit_cost),
        source: row.source,
        effective_from: row.effective_from,
      });
    }
  }
  return latest;
}

/** Insert a manual cost row (dashboard PATCH). Always wins over future syncs. */
async function setManualCost(brandId, variantId, unitCost) {
  const { data, error } = await supabase
    .from('ivy_product_costs')
    .insert({
      brand_id: brandId,
      shopify_variant_id: bareVariantId(variantId),
      unit_cost: unitCost,
      source: 'manual',
    })
    .select('shopify_variant_id, unit_cost, source, effective_from')
    .single();
  if (error) throw new Error(`manual cost insert failed: ${error.message}`);
  return data;
}

/**
 * Absorb Shopify "cost per item" values from a product sync.
 * @param {string} brandId
 * @param {Array<{variantId: string, shopifyUnitCost: number|null}>} variants
 * Rules: manual rows always win (never overwritten by sync); a shopify row is
 * only appended when the value actually changed (no row-per-sync noise).
 */
async function syncShopifyCosts(brandId, variants) {
  const withCost = (variants || []).filter(
    (v) => v.variantId && v.shopifyUnitCost != null && Number.isFinite(v.shopifyUnitCost) && v.shopifyUnitCost >= 0
  );
  if (withCost.length === 0) return { inserted: 0 };

  const latest = await getLatestCosts(brandId);
  const rows = [];
  for (const v of withCost) {
    const current = latest.get(v.variantId);
    if (current && current.source === 'manual') continue;           // manual wins
    if (current && Number(current.unit_cost) === v.shopifyUnitCost) continue; // unchanged
    rows.push({
      brand_id: brandId,
      shopify_variant_id: v.variantId,
      unit_cost: v.shopifyUnitCost,
      source: 'shopify',
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('ivy_product_costs').insert(rows);
    if (error) throw new Error(`shopify cost sync insert failed: ${error.message}`);
  }
  return { inserted: rows.length };
}

module.exports = { getLatestCosts, setManualCost, syncShopifyCosts };
