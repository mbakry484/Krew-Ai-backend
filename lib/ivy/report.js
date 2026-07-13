// =============================================================================
// IVY — Telegram P&L report (one message, Ivy's voice, no PDF)
// =============================================================================

const { getProfitSummary } = require('./profit');

const egp = (n) => `EGP ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const PERIOD_LABEL = {
  this_month: 'this month',
  last_month: 'last month',
  last_90: 'the last 90 days',
  last_7: 'this week',
};

/** Render a profit summary as a single Telegram message. */
function formatProfitReport(summary) {
  const label = PERIOD_LABEL[summary.period] || summary.period;
  const profit = Number(summary.real_net_profit) || 0;
  const verdict = profit > 0
    ? `✅ You're ${egp(profit)} in the green ${label}.`
    : profit < 0
      ? `🔻 You're ${egp(Math.abs(profit))} in the red ${label}.`
      : `⚖️ You broke exactly even ${label}.`;

  const lines = [
    `📊 Your numbers for ${label}:`,
    '',
    `Net revenue: ${egp(summary.net_revenue)}  (delivered ${egp(summary.gross_delivered)} − returns ${egp(summary.returns)})`,
    `COGS: ${egp(summary.cogs)}`,
    `Operating expenses: ${egp(summary.opex)}`,
    `Real profit: ${egp(profit)}`,
    '',
    `Cash moved: ${summary.cash_delta >= 0 ? '+' : '−'}${egp(Math.abs(summary.cash_delta))}`,
    `Return rate: ${Number(summary.return_rate_pct).toFixed(1)}%`,
    '',
    verdict,
  ];

  if (Number(summary.cogs_incomplete_orders) > 0) {
    lines.push(`(heads up: ${summary.cogs_incomplete_orders} delivered order(s) are missing unit costs, so real profit is overstated — fill in costs on the inventory page)`);
  }
  return lines.join('\n');
}

/** Fetch + format in one go — the /report command and weekly cron entry point. */
async function buildReportMessage(brandId, period = 'this_month') {
  const summary = await getProfitSummary(brandId, period);
  return formatProfitReport(summary);
}

module.exports = { formatProfitReport, buildReportMessage };
