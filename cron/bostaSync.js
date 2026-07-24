const cron = require('node-cron');
const { pollAllBrands } = require('../lib/bosta/ingest');
const { processEvents } = require('../lib/bosta/processor');

// =============================================================================
// BOSTA SYNC — polling (every 10 min) + event processing (every minute)
// =============================================================================
// Two separate schedules on purpose:
//
//   POLL    — talks to Bosta, appends facts to ivy_bosta_events. Rate-limited,
//             network-bound, capped at ~10 concurrent brands.
//   PROCESS — talks only to our own DB + Shopify, applies money. Runs far more
//             often so a webhook or a just-polled delivery books quickly.
//
// Splitting them means a Bosta outage can't stall finance application of events
// already ingested, and a Shopify hiccup can't stall ingestion.
//
// Both use an overlap guard rather than a queue: these are idempotent sweeps,
// so a skipped tick is harmless — the next one picks up the same work. Two
// copies running concurrently is not (duplicate Bosta calls, racing writes).
// =============================================================================

let pollRunning = false;
let processRunning = false;

async function runBostaPoll() {
  if (pollRunning) {
    console.warn('[bosta-poll] previous run still in progress — skipping this tick');
    return;
  }
  pollRunning = true;
  const startedAt = Date.now();
  try {
    const res = await pollAllBrands();
    if (res.brands > 0) {
      console.log(`📦 [bosta-poll] ${res.ok}/${res.brands} brand(s) polled in ${((Date.now() - startedAt) / 1000).toFixed(1)}s${res.failed ? `, ${res.failed} failed` : ''}`);
    }
  } catch (err) {
    console.error('[bosta-poll] sweep failed:', err.message);
  } finally {
    pollRunning = false;
  }
}

async function runBostaProcessor() {
  if (processRunning) return; // quiet — this ticks every minute
  processRunning = true;
  try {
    await processEvents();
  } catch (err) {
    console.error('[bosta-processor] sweep failed:', err.message);
  } finally {
    processRunning = false;
  }
}

function startBostaSyncCron() {
  // Every 10 minutes, per the build doc's polling cadence.
  cron.schedule('*/10 * * * *', runBostaPoll, { timezone: 'Africa/Cairo' });
  // Every minute — the doc's single-worker event processor.
  cron.schedule('* * * * *', runBostaProcessor, { timezone: 'Africa/Cairo' });
  console.log('📦 Bosta sync cron scheduled (poll every 10 min, process every 1 min)');
}

module.exports = { startBostaSyncCron, runBostaPoll, runBostaProcessor };
