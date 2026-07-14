// =============================================================================
// IVY — alert rule engine + Telegram delivery
// =============================================================================
// Steps 3–6 of the nightly job. Evaluates the five rules against
// ivy_alert_preferences, keeps ivy_alerts in sync (insert new / auto-resolve
// stale — the partial unique index guarantees one active alert per condition),
// then pushes new ones to the brand's linked OWNER Telegram chats in Ivy's
// voice with a 72h per-condition cooldown.
// =============================================================================

const supabase = require('../supabase');
const { sendMessage } = require('../../routes/telegram');
const { explodeVariants } = require('./variants');
const { getProductStats } = require('./stats');

const TELEGRAM_COOLDOWN_MS = 72 * 60 * 60 * 1000;

const DEFAULT_PREFERENCES = {
  best_seller_low_stock: { enabled: true, thresholdDays: 7 },
  any_low_stock: { enabled: true, thresholdDays: 5 },
  dead_stock: { enabled: true, thresholdDays: 60 },
  return_rate_spike: { enabled: true, thresholdPts: 5 },
  pool_low: { enabled: false, thresholdEgp: 10000 },
};

async function getAlertPreferences(brandId) {
  const { data } = await supabase
    .from('ivy_alert_preferences')
    .select('*')
    .eq('brand_id', brandId)
    .maybeSingle();
  if (!data) return { ...DEFAULT_PREFERENCES };
  return {
    best_seller_low_stock: { ...DEFAULT_PREFERENCES.best_seller_low_stock, ...data.best_seller_low_stock },
    any_low_stock: { ...DEFAULT_PREFERENCES.any_low_stock, ...data.any_low_stock },
    dead_stock: { ...DEFAULT_PREFERENCES.dead_stock, ...data.dead_stock },
    return_rate_spike: { ...DEFAULT_PREFERENCES.return_rate_spike, ...data.return_rate_spike },
    pool_low: { ...DEFAULT_PREFERENCES.pool_low, ...data.pool_low },
  };
}

/** Value-based return rate (%) for a calendar month offset (0 = this month). */
async function monthReturnRate(brandId, monthOffset) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthOffset, 1)).toISOString();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthOffset + 1, 1)).toISOString();

  const [deliveredRes, returnedRes] = await Promise.all([
    supabase.from('ivy_orders').select('delivered_value')
      .eq('brand_id', brandId).gte('delivered_at', from).lt('delivered_at', to),
    supabase.from('ivy_orders').select('returned_value')
      .eq('brand_id', brandId).gte('returned_at', from).lt('returned_at', to),
  ]);
  const delivered = (deliveredRes.data || []).reduce((s, r) => s + Number(r.delivered_value), 0);
  const returned = (returnedRes.data || []).reduce((s, r) => s + Number(r.returned_value), 0);
  if (delivered <= 0) return null;
  return (returned / delivered) * 100;
}

const variantLabel = (v) =>
  v.variantTitle && v.variantTitle !== 'Default Title'
    ? `${v.productTitle} ${v.variantTitle}`
    : v.productTitle || `variant ${v.variantId}`;

/** Evaluate all rules for one brand → candidate alerts keyed by dedupe_key. */
async function buildCandidates(brandId) {
  const prefs = await getAlertPreferences(brandId);
  const candidates = new Map();
  const add = (a) => candidates.set(a.dedupe_key, { brand_id: brandId, ...a });

  const [{ data: products }, stats, { data: pools }] = await Promise.all([
    supabase.from('products').select('name, image_url, variants').eq('brand_id', brandId),
    getProductStats(brandId),
    supabase.from('ivy_capitals').select('id, name, current_balance').eq('brand_id', brandId),
  ]);
  const variants = explodeVariants(products || []);

  for (const v of variants) {
    const s = stats.get(v.variantId);
    const velocity = s ? Number(s.velocity_30d) : 0;
    const daysOfStock = velocity > 0 ? v.unitsInStock / velocity : null;
    const label = variantLabel(v);

    if (prefs.best_seller_low_stock.enabled && s?.is_best_seller
        && daysOfStock != null && daysOfStock < prefs.best_seller_low_stock.thresholdDays) {
      add({
        type: 'best_seller_low_stock', severity: 'critical',
        title: `${label} is selling out`,
        body: `⚠️ heads up — ${label} is your best seller and you've got ~${Math.max(1, Math.round(daysOfStock))} days of stock left at current pace. ${v.unitsInStock} units remaining.`,
        shopify_variant_id: v.variantId,
        dedupe_key: `best_seller_low_stock:${v.variantId}`,
      });
      continue; // don't stack a plain low_stock alert on top for the same variant
    }

    if (prefs.any_low_stock.enabled && daysOfStock != null
        && daysOfStock < prefs.any_low_stock.thresholdDays && v.unitsInStock > 0) {
      add({
        type: 'low_stock', severity: 'warning',
        title: `${label} is running low`,
        body: `${label} is down to ~${Math.max(1, Math.round(daysOfStock))} days of stock at its current pace — ${v.unitsInStock} units left.`,
        shopify_variant_id: v.variantId,
        dedupe_key: `low_stock:${v.variantId}`,
      });
    }

    if (prefs.dead_stock.enabled && v.unitsInStock > 0 && s?.last_sale_at) {
      const daysSinceSale = (Date.now() - new Date(s.last_sale_at).getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceSale > prefs.dead_stock.thresholdDays) {
        add({
          type: 'dead_stock', severity: 'info',
          title: `${label} isn't moving`,
          body: `${label} hasn't sold in ${Math.round(daysSinceSale)} days and you're still holding ${v.unitsInStock} units. Might be time for a promo or bundle.`,
          shopify_variant_id: v.variantId,
          dedupe_key: `dead_stock:${v.variantId}`,
        });
      }
    }
  }

  if (prefs.return_rate_spike.enabled) {
    const [thisMonth, lastMonth] = await Promise.all([
      monthReturnRate(brandId, 0),
      monthReturnRate(brandId, 1),
    ]);
    if (thisMonth != null && lastMonth != null
        && thisMonth - lastMonth > prefs.return_rate_spike.thresholdPts) {
      add({
        type: 'return_rate_spike', severity: 'warning',
        title: 'Return rate is spiking',
        body: `Your return rate this month is ${thisMonth.toFixed(1)}% — up ${(thisMonth - lastMonth).toFixed(1)} points from last month's ${lastMonth.toFixed(1)}%. Worth checking sizing complaints or courier issues.`,
        shopify_variant_id: null,
        dedupe_key: 'return_rate_spike:month',
      });
    }
  }

  if (prefs.pool_low.enabled) {
    for (const pool of pools || []) {
      if (Number(pool.current_balance) < prefs.pool_low.thresholdEgp) {
        add({
          type: 'pool_low', severity: 'warning',
          title: `${pool.name} is running low`,
          body: `${pool.name} is down to EGP ${Math.round(Number(pool.current_balance)).toLocaleString('en-US')} — below your EGP ${Number(prefs.pool_low.thresholdEgp).toLocaleString('en-US')} floor.`,
          shopify_variant_id: null,
          dedupe_key: `pool_low:${pool.id}`,
        });
      }
    }
  }

  return candidates;
}

/**
 * Sync ivy_alerts with the freshly evaluated conditions for one brand:
 * insert newly-true ones, auto-resolve actives whose condition cleared.
 * Dismissed alerts stay dismissed (a dismissal outlives re-evaluation until
 * the condition clears and re-triggers, which inserts a fresh row).
 */
async function evaluateAlerts(brandId) {
  const candidates = await buildCandidates(brandId);

  const { data: nonResolved } = await supabase
    .from('ivy_alerts')
    .select('id, dedupe_key, status')
    .eq('brand_id', brandId)
    .in('status', ['active', 'dismissed']);

  const activeKeys = new Set();
  const suppressedKeys = new Set(); // dismissed + condition still true → stay quiet
  const staleIds = [];
  for (const row of nonResolved || []) {
    const stillTrue = candidates.has(row.dedupe_key);
    if (row.status === 'active') {
      if (stillTrue) activeKeys.add(row.dedupe_key);
      else staleIds.push(row.id);
    } else if (stillTrue) {
      suppressedKeys.add(row.dedupe_key);
    }
  }

  if (staleIds.length > 0) {
    await supabase.from('ivy_alerts').update({ status: 'resolved' }).in('id', staleIds);
  }

  const inserted = [];
  for (const [key, alert] of candidates) {
    if (activeKeys.has(key) || suppressedKeys.has(key)) continue;
    const { data, error } = await supabase.from('ivy_alerts').insert(alert).select('*').single();
    if (error) {
      if (error.code !== '23505') console.error(`[ivy-alerts] insert failed (${key}):`, error.message);
      continue; // 23505 = concurrent run already inserted it
    }
    inserted.push(data);
  }

  return { inserted, resolved: staleIds.length, active: candidates.size };
}

/**
 * Push unsent active alerts to the brand's linked OWNER chats.
 * Cooldown: a dedupe_key that was telegram-notified within the last 72h is
 * not re-sent even if it re-triggered as a fresh row.
 */
async function deliverAlertsToTelegram(brandId) {
  const { data: channels } = await supabase
    .from('owner_channels')
    .select('channel_user_id')
    .eq('brand_id', brandId)
    .eq('channel', 'telegram')
    .eq('role', 'owner')
    .not('verified_at', 'is', null);
  if (!channels || channels.length === 0) return { sent: 0 };

  const { data: unsent } = await supabase
    .from('ivy_alerts')
    .select('id, dedupe_key, body')
    .eq('brand_id', brandId)
    .eq('status', 'active')
    .is('telegram_sent_at', null);
  if (!unsent || unsent.length === 0) return { sent: 0 };

  const cooldownFloor = new Date(Date.now() - TELEGRAM_COOLDOWN_MS).toISOString();
  const { data: recentlySent } = await supabase
    .from('ivy_alerts')
    .select('dedupe_key')
    .eq('brand_id', brandId)
    .gte('telegram_sent_at', cooldownFloor);
  const cooling = new Set((recentlySent || []).map((r) => r.dedupe_key));

  let sent = 0;
  for (const alert of unsent) {
    if (cooling.has(alert.dedupe_key)) continue;
    for (const ch of channels) {
      await sendMessage(ch.channel_user_id, alert.body);
    }
    await supabase
      .from('ivy_alerts')
      .update({ telegram_sent_at: new Date().toISOString() })
      .eq('id', alert.id);
    sent++;
  }
  return { sent };
}

module.exports = { evaluateAlerts, deliverAlertsToTelegram, getAlertPreferences, DEFAULT_PREFERENCES };
