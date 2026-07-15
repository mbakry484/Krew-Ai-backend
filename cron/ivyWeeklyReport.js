const cron = require('node-cron');
const supabase = require('../lib/supabase');
const { sendMessage } = require('../routes/telegram');
const { buildReportMessage } = require('../lib/ivy/report');
const { periodRange } = require('../lib/ivy/profit');

// =============================================================================
// IVY WEEKLY REPORT — Sunday 09:00 Cairo, Telegram, owners only
// =============================================================================
// Sends the "week in numbers" skeleton to every brand that (a) has a verified owner
// Telegram chat and (b) had any activity in the last 7 days — an expense
// logged or a delivery/return booked. Quiet brands get no message.
// =============================================================================

async function brandHadRecentActivity(brandId) {
  const { from } = periodRange('last_7');
  const [expensesRes, deliveredRes, returnedRes] = await Promise.all([
    supabase.from('ivy_expenses').select('id', { count: 'exact', head: true })
      .eq('brand_id', brandId).gte('spent_at', from),
    supabase.from('ivy_orders').select('id', { count: 'exact', head: true })
      .eq('brand_id', brandId).gte('delivered_at', from),
    supabase.from('ivy_orders').select('id', { count: 'exact', head: true })
      .eq('brand_id', brandId).gte('returned_at', from),
  ]);
  return (expensesRes.count || 0) + (deliveredRes.count || 0) + (returnedRes.count || 0) > 0;
}

async function runIvyWeeklyReport() {
  console.log('📬 [ivy-weekly] sending weekly reports…');

  const { data: channels, error } = await supabase
    .from('owner_channels')
    .select('brand_id, channel_user_id')
    .eq('channel', 'telegram')
    .eq('role', 'owner')
    .not('verified_at', 'is', null);
  if (error) {
    console.error('[ivy-weekly] failed to list owner channels:', error.message);
    return;
  }

  // Group chats by brand so a multi-owner brand builds its report once.
  const byBrand = new Map();
  for (const ch of channels || []) {
    if (!byBrand.has(ch.brand_id)) byBrand.set(ch.brand_id, []);
    byBrand.get(ch.brand_id).push(ch.channel_user_id);
  }

  let sent = 0;
  for (const [brandId, chatIds] of byBrand) {
    try {
      if (!(await brandHadRecentActivity(brandId))) continue;
      // The skeleton carries its own 📊 header — no wrapper line.
      const message = await buildReportMessage(brandId, 'last_7');
      for (const chatId of chatIds) {
        await sendMessage(chatId, message);
        sent++;
      }
    } catch (err) {
      console.error(`[ivy-weekly] brand ${brandId} failed:`, err.message);
    }
  }
  console.log(`📬 [ivy-weekly] done — ${sent} message(s) sent`);
}

function startIvyWeeklyReportCron() {
  console.log('⏰ Ivy weekly report scheduled (Sunday 09:00 Africa/Cairo)');
  cron.schedule('0 9 * * 0', () => {
    runIvyWeeklyReport().catch((err) => console.error('[ivy-weekly] fatal:', err.message));
  }, { timezone: 'Africa/Cairo' });
}

module.exports = { startIvyWeeklyReportCron, runIvyWeeklyReport };
