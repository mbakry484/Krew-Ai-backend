const cron = require('node-cron');
const supabase = require('../lib/supabase');
const { getValidAccessToken } = require('../lib/shopify');
const { autoSyncProducts } = require('../routes/integrations');
const { computeProductStats } = require('../lib/ivy/stats');
const { evaluateAlerts, deliverAlertsToTelegram } = require('../lib/ivy/alerts');

// =============================================================================
// IVY NIGHTLY — full reconcile + velocity + alerts (03:00 Cairo)
// =============================================================================
// Per brand with a connected Shopify store:
//   1. Full product re-sync (stock levels, prices, Shopify unit costs — the
//      cost absorb lives inside autoSyncProducts).
//   2. Recompute ivy_product_stats (30d velocity, revenue, best sellers).
//   3. Evaluate alert rules against preferences; insert new / auto-resolve
//      cleared; push new alerts to linked owner Telegram chats (72h cooldown).
// One brand failing must never block the rest.
// =============================================================================

async function runIvyNightly() {
  const startedAt = Date.now();
  console.log('🌙 [ivy-nightly] starting…');

  const { data: integrations, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('platform', 'shopify')
    .not('brand_id', 'is', null);
  if (error) {
    console.error('[ivy-nightly] failed to list Shopify integrations:', error.message);
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const integration of integrations || []) {
    const brandId = integration.brand_id;
    const shop = integration.shopify_shop_domain;
    try {
      // 1. Stock + cost reconcile
      try {
        const accessToken = await getValidAccessToken(integration);
        await autoSyncProducts({ shop, access_token: accessToken, brand_id: brandId });
      } catch (err) {
        // Stats/alerts still run on yesterday's stock rather than skipping the brand.
        console.error(`[ivy-nightly] product sync failed for ${shop}: ${err.message}`);
      }

      // 2. Velocity + best sellers
      const stats = await computeProductStats(brandId);

      // 3. Alerts + Telegram
      const alerts = await evaluateAlerts(brandId);
      const delivery = await deliverAlertsToTelegram(brandId);

      console.log(
        `[ivy-nightly] ${shop}: ${stats.variants} variants, ${stats.bestSellers} best sellers, ` +
        `${alerts.inserted.length} new / ${alerts.resolved} resolved alerts, ${delivery.sent} sent to Telegram`
      );
      ok++;
    } catch (err) {
      console.error(`[ivy-nightly] brand ${brandId} (${shop}) failed:`, err.message);
      failed++;
    }
  }

  console.log(`🌙 [ivy-nightly] done in ${Math.round((Date.now() - startedAt) / 1000)}s — ${ok} ok, ${failed} failed`);
}

function startIvyNightlyCron() {
  console.log('⏰ Ivy nightly job scheduled (03:00 Africa/Cairo)');
  cron.schedule('0 3 * * *', () => {
    runIvyNightly().catch((err) => console.error('[ivy-nightly] fatal:', err.message));
  }, { timezone: 'Africa/Cairo' });
}

module.exports = { startIvyNightlyCron, runIvyNightly };
