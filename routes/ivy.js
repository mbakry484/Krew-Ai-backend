const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

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
      .select('id')
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

    const { amount, category, capital_id, source, note, spent_at } = req.body || {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    if (!EXPENSE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'invalid category' });
    if (!capital_id) return res.status(400).json({ error: 'capital_id is required' });
    const src = source || 'text';
    if (!EXPENSE_SOURCES.includes(src)) return res.status(400).json({ error: 'invalid source' });

    // Verify the target pool belongs to this brand (also guards the FK).
    const { data: pool } = await supabase
      .from('ivy_capitals')
      .select('id')
      .eq('id', capital_id)
      .eq('brand_id', brandId)
      .maybeSingle();
    if (!pool) return res.status(400).json({ error: 'Capital pool not found' });

    const { data, error } = await supabase
      .from('ivy_expenses')
      .insert({
        brand_id: brandId,
        amount: value,
        category,
        capital_id,
        source: src,
        note: (note != null ? String(note) : ''),
        spent_at: spent_at || new Date().toISOString(),
      })
      .select('*')
      .single();

    if (error) throw error;
    // current_balance is derived on GET, so no balance write is needed here.
    return res.status(201).json(data);
  } catch (err) {
    console.error('[ivy] create expense error:', err.message);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
});

module.exports = router;
