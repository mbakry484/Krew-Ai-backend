const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { getProfitSummary } = require('../lib/ivy/profit');
const { getLatestCosts, setManualCost } = require('../lib/ivy/costs');
const { explodeVariants, bareVariantId } = require('../lib/ivy/variants');
const { getProductStats } = require('../lib/ivy/stats');
const { getAlertPreferences } = require('../lib/ivy/alerts');

// =============================================================================
// IVY — FINANCIAL VISIBILITY · backend
// =============================================================================
// Thin CRUD over the Ivy tables. All reporting/P&L math lives client-side
// (see lib/ivy/ivyClient.ts selectors) — the backend just serves raw rows.
//
// SCOPE (this build): only Capitals + Expenses are wired to the DB.
// Revenue channels / snapshots / inventory / target are returned as empty /
// default shapes so the frontend keeps rendering (dummy) without extra work.
//
// current_balance is COMPUTED at read time:
//   current_balance = initial_amount − Σ(expenses.amount where capital_id = pool)
// so there is no stored balance to drift. POST /expenses only inserts a row.
// =============================================================================

const EXPENSE_CATEGORIES = [
  'inventory_materials', 'marketing_ads', 'shipping_fulfillment', 'salaries',
  'packaging', 'software', 'rent_utilities', 'fees_commissions', 'other',
];
const EXPENSE_SOURCES = ['text', 'voice', 'receipt'];
const EXPENSE_CLASSES = ['opex', 'inventory_purchase'];
const CAPITAL_COLORS = ['teal', 'obsidian', 'silver', 'copper', 'indigo', 'rose'];

/** Resolve the authenticated user's brand_id. Prefers the value the auth
 *  middleware already attached (Supabase path); falls back to a users lookup
 *  (legacy JWT path) so both token types work. */
async function resolveBrandId(req) {
  if (req.user && req.user.brand_id) return req.user.brand_id;
  const userId = req.user && req.user.user_id;
  if (!userId) return null;
  const { data: user } = await supabase
    .from('users')
    .select('brand_id')
    .eq('id', userId)
    .maybeSingle();
  return user ? user.brand_id : null;
}

/** initial_amount − Σ expenses for that pool, keyed by capital_id. */
function computeBalances(capitals, expenses) {
  const spent = new Map();
  for (const e of expenses) {
    spent.set(e.capital_id, (spent.get(e.capital_id) || 0) + Number(e.amount));
  }
  return capitals.map((c) => ({
    ...c,
    current_balance: Number(c.initial_amount) - (spent.get(c.id) || 0),
  }));
}

// ── GET /ivy — bootstrap (the one read the app needs) ────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const [capitalsRes, expensesRes] = await Promise.all([
      supabase.from('ivy_capitals').select('*').eq('brand_id', brandId).order('created_at', { ascending: true }),
      supabase.from('ivy_expenses').select('*').eq('brand_id', brandId).order('spent_at', { ascending: false }),
    ]);

    if (capitalsRes.error) throw capitalsRes.error;
    if (expensesRes.error) throw expensesRes.error;

    const expenses = expensesRes.data || [];
    const capitals = computeBalances(capitalsRes.data || [], expenses);

    return res.json({
      capitals,
      expenses,
      // Dummy shapes — not wired to the DB yet, kept so the frontend renders.
      revenue_channels: [],
      revenue_snapshots: [],
      inventory: { id: 'inv-none', brand_id: brandId, inventory_value: 0, units: 0, updated_at: new Date().toISOString() },
      target: { id: 'target-none', brand_id: brandId, sales_target: 0, period: 'monthly' },
      ivy_enabled: true,
    });
  } catch (err) {
    console.error('[ivy] bootstrap error:', err.message);
    return res.status(500).json({ error: 'Failed to load Ivy data' });
  }
});

// ── POST /ivy/capitals ───────────────────────────────────────────────────────
router.post('/capitals', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { name, initial_amount, color } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const amount = Number(initial_amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'initial_amount must be >= 0' });
    const col = color || 'teal';
    if (!CAPITAL_COLORS.includes(col)) return res.status(400).json({ error: 'invalid color' });

    const { data, error } = await supabase
      .from('ivy_capitals')
      .insert({
        brand_id: brandId,
        name: String(name).trim(),
        initial_amount: amount,
        current_balance: amount, // fresh pool has no expenses yet
        color: col,
      })
      .select('*')
      .single();

    if (error) throw error;

    // Money-IN ledger: the opening balance is a pool transaction so the
    // profit layer's cash_delta can attribute it to the right period.
    await supabase.from('ivy_pool_transactions').insert({
      brand_id: brandId,
      capital_id: data.id,
      type: 'opening_balance',
      amount,
    });

    return res.status(201).json(data);
  } catch (err) {
    console.error('[ivy] create capital error:', err.message);
    return res.status(500).json({ error: 'Failed to create capital pool' });
  }
});

// ── PATCH /ivy/capitals/:id — rename / recolor / re-inject ───────────────────
router.patch('/capitals/:id', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { id } = req.params;
    const { name, initial_amount, color } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const amount = Number(initial_amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'initial_amount must be >= 0' });
    const col = color || 'teal';
    if (!CAPITAL_COLORS.includes(col)) return res.status(400).json({ error: 'invalid color' });

    // Ensure the pool belongs to this brand.
    const { data: existing } = await supabase
      .from('ivy_capitals')
      .select('id, initial_amount')
      .eq('id', id)
      .eq('brand_id', brandId)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Capital pool not found' });

    // Recompute balance = new injected − already-spent from this pool.
    const { data: expenses } = await supabase
      .from('ivy_expenses')
      .select('amount')
      .eq('brand_id', brandId)
      .eq('capital_id', id);
    const spent = (expenses || []).reduce((s, e) => s + Number(e.amount), 0);

    const { data, error } = await supabase
      .from('ivy_capitals')
      .update({
        name: String(name).trim(),
        initial_amount: amount,
        current_balance: amount - spent,
        color: col,
      })
      .eq('id', id)
      .eq('brand_id', brandId)
      .select('*')
      .single();

    if (error) throw error;

    // Re-injection (or correction downward) is a signed money-in transaction.
    const delta = amount - Number(existing.initial_amount);
    if (delta !== 0) {
      await supabase.from('ivy_pool_transactions').insert({
        brand_id: brandId,
        capital_id: id,
        type: delta > 0 ? 'injection' : 'withdrawal',
        amount: delta,
      });
    }

    return res.json(data);
  } catch (err) {
    console.error('[ivy] update capital error:', err.message);
    return res.status(500).json({ error: 'Failed to update capital pool' });
  }
});

// ── DELETE /ivy/capitals/:id — 409 if the pool has expenses ──────────────────
router.delete('/capitals/:id', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { id } = req.params;

    const { count } = await supabase
      .from('ivy_expenses')
      .select('id', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .eq('capital_id', id);

    if (count && count > 0) {
      return res.status(409).json({ error: "Pool has logged expenses and can't be deleted" });
    }

    const { error } = await supabase
      .from('ivy_capitals')
      .delete()
      .eq('id', id)
      .eq('brand_id', brandId);

    if (error) throw error;
    // Return a JSON body (not a bare 204) so the frontend's fetch(...).json() is happy.
    return res.json({ success: true });
  } catch (err) {
    console.error('[ivy] delete capital error:', err.message);
    return res.status(500).json({ error: 'Failed to delete capital pool' });
  }
});

// ── POST /ivy/expenses ───────────────────────────────────────────────────────
router.post('/expenses', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { amount, category, capital_id, source, note, spent_at, expense_class } = req.body || {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    if (!EXPENSE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'invalid category' });
    if (!capital_id) return res.status(400).json({ error: 'capital_id is required' });
    const src = source || 'text';
    if (!EXPENSE_SOURCES.includes(src)) return res.status(400).json({ error: 'invalid source' });
    if (expense_class != null && !EXPENSE_CLASSES.includes(expense_class)) {
      return res.status(400).json({ error: 'invalid expense_class' });
    }

    // Verify the target pool belongs to this brand (also guards the FK).
    const { data: pool } = await supabase
      .from('ivy_capitals')
      .select('id')
      .eq('id', capital_id)
      .eq('brand_id', brandId)
      .maybeSingle();
    if (!pool) return res.status(400).json({ error: 'Capital pool not found' });

    // Write through the atomic RPC so the expense insert and the capital
    // balance decrement happen in one row-locked transaction (same path Ivy's
    // Telegram agent uses). This keeps the stored current_balance authoritative.
    const { data: result, error } = await supabase.rpc('ivy_log_expense', {
      p_brand_id: brandId,
      p_amount: value,
      p_category: category,
      p_capital_id: capital_id,
      p_note: (note != null ? String(note) : ''),
      p_source: src,
      p_spent_at: spent_at || new Date().toISOString(),
      // null → the RPC infers the class from the category (inventory_materials
      // is a stock buy; everything else is opex).
      p_expense_class: expense_class || null,
    });

    if (error) throw error;
    if (!result || !result.ok) {
      const code = result && result.error;
      if (code === 'capital_not_found') return res.status(400).json({ error: 'Capital pool not found' });
      if (code === 'invalid_amount') return res.status(400).json({ error: 'amount must be > 0' });
      return res.status(500).json({ error: 'Failed to create expense' });
    }

    // Return the created expense row so the response contract is unchanged.
    const { data: expense } = await supabase
      .from('ivy_expenses')
      .select('*')
      .eq('id', result.expense_id)
      .single();
    return res.status(201).json(expense);
  } catch (err) {
    console.error('[ivy] create expense error:', err.message);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
});

// =============================================================================
// PROFIT LAYER + INVENTORY INTELLIGENCE endpoints
// =============================================================================

// Map DB alert enums → the API/frontend enums (types.ts InventoryAlert).
const ALERT_TYPE_API = {
  best_seller_low_stock: 'best_seller_low',
  low_stock: 'low_stock',
  dead_stock: 'dead_stock',
  return_rate_spike: 'return_spike',
  pool_low: 'pool_low',
};
const ALERT_SEVERITY_API = { critical: 'critical', warning: 'warning', info: 'neutral' };
const INVENTORY_ALERT_TYPES = ['best_seller_low_stock', 'low_stock', 'dead_stock', 'return_rate_spike'];

// ── GET /ivy/overview — the "was this period actually good?" read ────────────
router.get('/overview', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const period = ['this_month', 'last_month', 'last_90'].includes(req.query.period)
      ? req.query.period
      : 'this_month';
    const s = await getProfitSummary(brandId, period);

    return res.json({
      period,
      netRevenue: s.net_revenue,
      grossDelivered: s.gross_delivered,
      returns: s.returns,
      returnRatePct: s.return_rate_pct,
      cogsThisMonth: s.cogs,
      opexThisMonth: s.opex,
      inventorySpendThisMonth: s.inventory_spend,
      realNetProfit: s.real_net_profit,
      cashDeltaThisMonth: s.cash_delta,
      costCoveragePct: s.cost_coverage_pct,
      cogsIncompleteOrders: s.cogs_incomplete_orders,
    });
  } catch (err) {
    console.error('[ivy] overview error:', err.message);
    return res.status(500).json({ error: 'Failed to load overview' });
  }
});

// ── GET /ivy/inventory/products — Shopify stock ⋈ costs ⋈ sales signals ──────
router.get('/inventory/products', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const [{ data: products, error }, costs, stats] = await Promise.all([
      supabase.from('products').select('name, image_url, variants').eq('brand_id', brandId),
      getLatestCosts(brandId),
      getProductStats(brandId),
    ]);
    if (error) throw error;

    const rows = explodeVariants(products || []).map((v) => {
      const cost = costs.get(v.variantId);
      const s = stats.get(v.variantId);
      const velocity = s ? Number(s.velocity_30d) : 0;
      return {
        variantId: v.variantId,
        productTitle: v.productTitle,
        variantTitle: v.variantTitle,
        imageUrl: v.imageUrl,
        unitsInStock: v.unitsInStock,
        sellingPrice: v.sellingPrice,
        unitCost: cost ? Number(cost.unit_cost) : null,
        costSource: cost ? cost.source : null,
        velocity30d: velocity,
        daysOfStock: velocity > 0 ? Math.round((v.unitsInStock / velocity) * 10) / 10 : null,
        isBestSeller: s ? s.is_best_seller : false,
        lastSaleAt: s ? s.last_sale_at : null,
      };
    });

    return res.json(rows);
  } catch (err) {
    console.error('[ivy] inventory products error:', err.message);
    return res.status(500).json({ error: 'Failed to load inventory products' });
  }
});

// ── PATCH /ivy/inventory/products/:variantId/cost — append a manual cost ─────
router.patch('/inventory/products/:variantId/cost', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const variantId = bareVariantId(req.params.variantId);
    const unitCost = Number(req.body?.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      return res.status(400).json({ error: 'unitCost must be a number >= 0' });
    }

    // The variant must exist in this brand's catalog — no cost rows for junk ids.
    const { data: products } = await supabase
      .from('products')
      .select('name, image_url, variants')
      .eq('brand_id', brandId);
    const known = explodeVariants(products || []).some((v) => v.variantId === variantId);
    if (!known) return res.status(404).json({ error: 'Variant not found for this brand' });

    const row = await setManualCost(brandId, variantId, unitCost);
    return res.json({
      variantId: row.shopify_variant_id,
      unitCost: Number(row.unit_cost),
      costSource: row.source,
      effectiveFrom: row.effective_from,
    });
  } catch (err) {
    console.error('[ivy] set cost error:', err.message);
    return res.status(500).json({ error: 'Failed to set unit cost' });
  }
});

// ── GET /ivy/alerts?scope=inventory|all — active alerts only ─────────────────
router.get('/alerts', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    let query = supabase
      .from('ivy_alerts')
      .select('id, type, severity, title, body, shopify_variant_id, created_at')
      .eq('brand_id', brandId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if ((req.query.scope || 'all') === 'inventory') {
      query = query.in('type', INVENTORY_ALERT_TYPES);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json((data || []).map((a) => ({
      id: a.id,
      type: ALERT_TYPE_API[a.type] || a.type,
      severity: ALERT_SEVERITY_API[a.severity] || a.severity,
      title: a.title,
      body: a.body,
      variantId: a.shopify_variant_id || undefined,
      createdAt: a.created_at,
    })));
  } catch (err) {
    console.error('[ivy] alerts error:', err.message);
    return res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// ── POST /ivy/alerts/:id/dismiss ──────────────────────────────────────────────
router.post('/alerts/:id/dismiss', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { data, error } = await supabase
      .from('ivy_alerts')
      .update({ status: 'dismissed' })
      .eq('id', req.params.id)
      .eq('brand_id', brandId)
      .eq('status', 'active')
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'Alert not found' });

    return res.json({ success: true });
  } catch (err) {
    console.error('[ivy] dismiss alert error:', err.message);
    return res.status(500).json({ error: 'Failed to dismiss alert' });
  }
});

// ── Alert preferences — camelCase API ⇄ snake_case jsonb columns ─────────────
const prefsToApi = (p) => ({
  bestSellerLowStock: p.best_seller_low_stock,
  anyLowStock: p.any_low_stock,
  deadStock: p.dead_stock,
  returnRateSpike: p.return_rate_spike,
  poolLow: p.pool_low,
});

router.get('/alert-preferences', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });
    return res.json(prefsToApi(await getAlertPreferences(brandId)));
  } catch (err) {
    console.error('[ivy] alert prefs error:', err.message);
    return res.status(500).json({ error: 'Failed to load alert preferences' });
  }
});

router.patch('/alert-preferences', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const body = req.body || {};
    const current = await getAlertPreferences(brandId);

    // Partial update: merge each provided section over the stored/default one.
    const clean = (section, existing, numericKey) => {
      const s = { ...existing };
      if (section && typeof section === 'object') {
        if (typeof section.enabled === 'boolean') s.enabled = section.enabled;
        const n = Number(section[numericKey]);
        if (Number.isFinite(n) && n >= 0) s[numericKey] = n;
      }
      return s;
    };

    const row = {
      brand_id: brandId,
      best_seller_low_stock: clean(body.bestSellerLowStock, current.best_seller_low_stock, 'thresholdDays'),
      any_low_stock: clean(body.anyLowStock, current.any_low_stock, 'thresholdDays'),
      dead_stock: clean(body.deadStock, current.dead_stock, 'thresholdDays'),
      return_rate_spike: clean(body.returnRateSpike, current.return_rate_spike, 'thresholdPts'),
      pool_low: clean(body.poolLow, current.pool_low, 'thresholdEgp'),
    };

    const { error } = await supabase
      .from('ivy_alert_preferences')
      .upsert(row, { onConflict: 'brand_id' });
    if (error) throw error;

    return res.json(prefsToApi(row));
  } catch (err) {
    console.error('[ivy] update alert prefs error:', err.message);
    return res.status(500).json({ error: 'Failed to update alert preferences' });
  }
});

// ── Onboarding ────────────────────────────────────────────────────────────────
router.get('/onboarding/status', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const [{ data: brand }, { count: poolCount }, { count: linkedCount }] = await Promise.all([
      supabase.from('brands').select('ivy_onboarding_completed').eq('id', brandId).maybeSingle(),
      supabase.from('ivy_capitals').select('id', { count: 'exact', head: true }).eq('brand_id', brandId),
      supabase.from('owner_channels').select('id', { count: 'exact', head: true })
        .eq('brand_id', brandId).eq('channel', 'telegram').not('verified_at', 'is', null),
    ]);

    return res.json({
      completed: brand ? brand.ivy_onboarding_completed === true : false,
      telegramLinked: (linkedCount || 0) > 0,
      poolCount: poolCount || 0,
    });
  } catch (err) {
    console.error('[ivy] onboarding status error:', err.message);
    return res.status(500).json({ error: 'Failed to load onboarding status' });
  }
});

router.post('/onboarding/complete', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { error } = await supabase
      .from('brands')
      .update({ ivy_onboarding_completed: true })
      .eq('id', brandId);
    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error('[ivy] onboarding complete error:', err.message);
    return res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

// ── GET /ivy/telegram/link-code — owner self-link deep link ───────────────────
// Same single-use token flow the member invites use (routes/members.js /
// routes/telegram.js handleStart), but for the OWNER's own chat, generated
// from the onboarding screen. A dashboard session is inherently the owner.
router.get('/telegram/link-code', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
    if (!botUsername) {
      console.error('[ivy] TELEGRAM_BOT_USERNAME is not set');
      return res.status(500).json({ error: 'Telegram bot is not configured' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error } = await supabase.from('owner_link_tokens').insert({
      token,
      brand_id: brandId,
      member_id: null,
      role: 'owner',
      expires_at: expiresAt,
    });
    if (error) throw error;

    return res.json({
      code: `IVY-${token.slice(0, 4).toUpperCase()}`,
      deepLink: `https://t.me/${botUsername}?start=${token}`,
      expiresAt,
    });
  } catch (err) {
    console.error('[ivy] link-code error:', err.message);
    return res.status(500).json({ error: 'Failed to generate link code' });
  }
});

module.exports = router;
