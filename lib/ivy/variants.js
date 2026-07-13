// =============================================================================
// IVY — variant normalization helpers
// =============================================================================
// The products.variants jsonb column holds two shapes depending on the write
// path: the GraphQL auto-sync stores { id: "gid://shopify/ProductVariant/N",
// inventoryQuantity, ... } while the embedded-app REST webhooks store
// { id: N, inventory_quantity, ... }. Everything in the Ivy profit/inventory
// layer keys on the BARE numeric variant id as text — normalize here, once.
// =============================================================================

/** "gid://shopify/ProductVariant/123" | 123 | "123" → "123" (null-safe). */
function bareVariantId(id) {
  if (id == null) return null;
  const s = String(id);
  if (s.startsWith('gid://')) {
    const parts = s.split('/');
    return parts[parts.length - 1] || null;
  }
  return s;
}

/** One variant object from products.variants jsonb → a canonical shape. */
function normalizeVariant(v, product) {
  if (!v) return null;
  const unitCostRaw = v.inventoryItem?.unitCost?.amount ?? v.unit_cost ?? null;
  return {
    variantId: bareVariantId(v.id),
    variantTitle: v.title || '',
    productTitle: product?.name || '',
    sku: v.sku || null,
    sellingPrice: Number(v.price) || 0,
    unitsInStock: Number(v.inventoryQuantity ?? v.inventory_quantity ?? 0) || 0,
    imageUrl: v.image?.url || product?.image_url || null,
    // Shopify "cost per item" when the GraphQL sync captured it; null otherwise.
    shopifyUnitCost: unitCostRaw != null ? Number(unitCostRaw) : null,
  };
}

/** Explode a brand's product rows into normalized variant rows. */
function explodeVariants(products) {
  const out = [];
  for (const p of products || []) {
    for (const raw of Array.isArray(p.variants) ? p.variants : []) {
      const v = normalizeVariant(raw, p);
      if (v && v.variantId) out.push(v);
    }
  }
  return out;
}

module.exports = { bareVariantId, normalizeVariant, explodeVariants };
