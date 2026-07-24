// =============================================================================
// BOSTA — ingestion (polling primary, historical sync, event insertion)
// =============================================================================
// We do NOT create deliveries, so we cannot attach a webhook to the founder's
// existing sales (Bosta webhooks are per-delivery, registered at creation).
// Polling is therefore the PRIMARY path, not a fallback.
//
// Flow per brand:
//   1. Paginate POST /deliveries/search (unfiltered by state — see client.js).
//   2. Upsert each delivery into ivy_deliveries.
//   3. Diff the stored state label against the incoming one; a change that maps
//      to a finance event appends to ivy_bosta_events.
//   4. Advance last_poll_cursor to the max updatedAt ingested.
//
// The events table is the durable boundary: ingestion only ever appends facts,
// and lib/bosta/processor.js applies money separately. That split is what makes
// a failed finance write retryable without re-fetching from Bosta.
// =============================================================================

const supabase = require('../supabase');
const { paginateDeliveries, getDeliveryByTracking, BostaError } = require('./client');
const {
  eventForLabel,
  isSendDelivery,
  stateLabelOf,
  stateCodeOf,
  EVENT_STATE_CHANGE,
} = require('./stateMap');
const {
  listPollableBrands,
  getCredentials,
  markFromError,
  markConnectionStatus,
  updatePollCursor,
  setHistoricalSyncState,
} = require('./credentials');

const HISTORICAL_DAYS = 90;
const POLL_CONCURRENCY = 10; // doc: cap concurrent brands to ~10 workers

// How many consecutive all-stale pages before we stop paginating a poll.
//
// The doc says "stop paginating once updatedAt <= cursor", which assumes Bosta
// returns results newest-first. Their spec documents no sort parameter and no
// date filter, so that ordering is an ASSUMPTION we can't verify without a live
// key. Stopping on the very first stale delivery would silently skip newer ones
// if ordering is imperfect — under-reported revenue with no error. Requiring two
// consecutive fully-stale PAGES is cheap insurance against mild disorder while
// still bounding a routine poll to a couple of pages.
const STALE_PAGE_LIMIT = 2;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Normalize a Bosta delivery payload. Tolerant by design — Bosta has shipped
 * both flat and nested shapes across API versions, and a shape change must
 * degrade to "missing field", never throw mid-poll.
 */
function parseDelivery(raw = {}) {
  const stateLabel = stateLabelOf(raw);
  const { event, known } = eventForLabel(stateLabel);

  const businessReference =
    raw.businessReference ??
    raw.business_reference ??
    raw.specs?.packageDetails?.businessReference ??
    raw.orderReference ??
    null;

  const uniqueBusinessReference =
    raw.uniqueBusinessReference ?? raw.unique_business_reference ?? null;

  // Revenue preference: goodsInfo.amount is the true item value; cod may bundle
  // shipping. Both are kept — cod_amount drives payout reconciliation.
  const goodsAmount = num(raw.goodsInfo?.amount ?? raw.specs?.goodsInfo?.amount);
  const codAmount = num(raw.cod ?? raw.codAmount ?? raw.cod_amount ?? raw.specs?.cod);

  const shipmentFees = num(
    raw.shipmentFees ?? raw.shipmentFee ?? raw.price?.total ?? raw.pricing?.shipmentFees ?? raw.priceAfterVat
  );

  return {
    bostaDeliveryId: String(raw._id ?? raw.id ?? raw.deliveryId ?? raw.trackingNumber ?? ''),
    trackingNumber: raw.trackingNumber ?? raw.tracking_number ?? null,
    businessReference,
    uniqueBusinessReference,
    orderReference: businessReference || uniqueBusinessReference || null,
    stateLabel,
    stateCode: stateCodeOf(raw),
    event,
    knownLabel: known,
    isSend: isSendDelivery(raw),
    deliveryTypeCode: num(raw.type?.code),
    deliveryTypeRaw: raw.type?.value ?? (typeof raw.type === 'string' ? raw.type : null),
    codAmount,
    goodsAmount,
    shipmentFees,
    cityName: raw.dropOffAddress?.city?.name ?? raw.pickupAddress?.city?.name ?? null,
    zoneName: raw.dropOffAddress?.zone?.name ?? raw.dropOffAddress?.district?.name ?? null,
    updatedAt: iso(raw.updatedAt ?? raw.updated_at ?? raw.state?.updatedAt) ?? null,
    createdAt: iso(raw.createdAt ?? raw.created_at) ?? null,
    // Bosta exposes the delivery moment under several names depending on the
    // endpoint; fall back to updatedAt so an event always has a timestamp.
    occurredAt:
      iso(raw.state?.updatedAt ?? raw.deliveredAt ?? raw.updatedAt ?? raw.updated_at) ||
      new Date().toISOString(),
    raw,
  };
}

/** Existing rows for the deliveries in this page, so we can diff state. */
async function loadExisting(brandId, deliveryIds) {
  if (deliveryIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('ivy_deliveries')
    .select('bosta_delivery_id, state_label, first_delivered_at, returned_at, cancelled_at')
    .eq('brand_id', brandId)
    .in('bosta_delivery_id', deliveryIds);
  if (error) throw new Error(`ivy_deliveries read failed: ${error.message}`);
  return new Map((data || []).map((r) => [r.bosta_delivery_id, r]));
}

/**
 * Persist one page: upsert deliveries, append events for state transitions.
 * @returns {Promise<{ingested:number, events:number, maxUpdatedAt:string|null, fresh:number}>}
 */
async function persistPage(brandId, deliveries, { source = 'poll', cursor = null } = {}) {
  const parsed = deliveries.map(parseDelivery).filter((d) => d.bostaDeliveryId);
  if (parsed.length === 0) return { ingested: 0, events: 0, maxUpdatedAt: null, fresh: 0 };

  // Dedupe within the page — Bosta can repeat a delivery across page boundaries
  // when the underlying list shifts between requests.
  const byId = new Map();
  for (const d of parsed) byId.set(d.bostaDeliveryId, d);
  const unique = [...byId.values()];

  const existing = await loadExisting(brandId, unique.map((d) => d.bostaDeliveryId));

  const rows = [];
  const events = [];
  let maxUpdatedAt = null;
  let fresh = 0;

  for (const d of unique) {
    if (d.updatedAt && (!maxUpdatedAt || d.updatedAt > maxUpdatedAt)) maxUpdatedAt = d.updatedAt;
    if (!cursor || !d.updatedAt || d.updatedAt > cursor) fresh += 1;

    if (!d.knownLabel && d.stateLabel) {
      // A label we've never seen. Feed-only by default — loud, because it might
      // be a finance state under new wording.
      console.warn(`[bosta] unknown state label "${d.stateLabel}" (brand ${brandId}, delivery ${d.bostaDeliveryId}) — treated as feed-only`);
    }

    const prev = existing.get(d.bostaDeliveryId);
    const prevLabel = prev?.state_label ?? null;

    const row = {
      brand_id: brandId,
      bosta_delivery_id: d.bostaDeliveryId,
      tracking_number: d.trackingNumber,
      business_reference: d.businessReference,
      unique_business_reference: d.uniqueBusinessReference,
      state_code: d.stateCode,
      state_label: d.stateLabel,
      state_value_raw: d.stateLabel,
      delivery_type_code: d.deliveryTypeCode,
      delivery_type_raw: d.deliveryTypeRaw,
      cod_amount: d.codAmount,
      goods_amount: d.goodsAmount,
      shipment_fees: d.shipmentFees,
      city_name: d.cityName,
      zone_name: d.zoneName,
      bosta_updated_at: d.updatedAt,
      raw: d.raw,
      updated_at: new Date().toISOString(),
    };

    // first_delivered_at is write-once: a delivery that bounces back to
    // "delivered" after a correction must not move the revenue date.
    if (d.event === 'delivered' && !prev?.first_delivered_at) row.first_delivered_at = d.occurredAt;
    if (d.event === 'returned' && !prev?.returned_at) row.returned_at = d.occurredAt;
    if (d.event === 'cancelled' && !prev?.cancelled_at) row.cancelled_at = d.occurredAt;

    rows.push(row);

    // Only append an event when the state actually CHANGED. Re-seeing the same
    // label every 10 minutes must not re-queue work.
    const stateChanged = prevLabel !== d.stateLabel;
    if (!stateChanged) continue;

    // Non-SEND deliveries (cash-collection, CRP, exchange) are stored for the
    // feed but never produce finance events. Guarded hard, per the doc.
    if (d.event !== EVENT_STATE_CHANGE && !d.isSend) {
      console.log(`[bosta] skipping finance event for non-SEND delivery ${d.bostaDeliveryId} (type: ${d.deliveryTypeRaw ?? d.deliveryTypeCode})`);
      continue;
    }
    if (d.event === EVENT_STATE_CHANGE) continue; // feed-only, nothing to process

    events.push({
      brand_id: brandId,
      bosta_delivery_id: d.bostaDeliveryId,
      event_type: d.event,
      from_state: prevLabel,
      to_state: d.stateLabel,
      occurred_at: d.occurredAt,
      source,
      raw: d.raw,
    });
  }

  const { error: upsertError } = await supabase
    .from('ivy_deliveries')
    .upsert(rows, { onConflict: 'brand_id,bosta_delivery_id' });
  if (upsertError) throw new Error(`ivy_deliveries upsert failed: ${upsertError.message}`);

  if (events.length > 0) {
    // ignoreDuplicates: the unique constraint is what makes polling and webhooks
    // safely redundant — whoever sees the transition first wins, the other no-ops.
    const { error: eventError } = await supabase
      .from('ivy_bosta_events')
      .upsert(events, { onConflict: 'brand_id,bosta_delivery_id,event_type,occurred_at', ignoreDuplicates: true });
    if (eventError) throw new Error(`ivy_bosta_events insert failed: ${eventError.message}`);
  }

  return { ingested: unique.length, events: events.length, maxUpdatedAt, fresh };
}

/**
 * Poll one brand for deliveries updated since its cursor.
 * Errors are classified onto connection_status and swallowed — one brand's bad
 * key must never stop the rest of the fleet.
 */
async function pollBrand(cred) {
  const brandId = cred.brand_id;
  const cursor = cred.last_poll_cursor || null;

  let totalIngested = 0;
  let totalEvents = 0;
  let maxSeen = cursor;
  let staleStreak = 0;

  try {
    await paginateDeliveries(
      cred.api_key,
      cred.env,
      async (deliveries) => {
        const res = await persistPage(brandId, deliveries, { source: 'poll', cursor });
        totalIngested += res.ingested;
        totalEvents += res.events;
        if (res.maxUpdatedAt && (!maxSeen || res.maxUpdatedAt > maxSeen)) maxSeen = res.maxUpdatedAt;

        if (!cursor) return false; // first poll after historical sync — take everything

        staleStreak = res.fresh === 0 ? staleStreak + 1 : 0;
        return staleStreak >= STALE_PAGE_LIMIT;
      },
      { limit: 100, maxPages: 50 }
    );

    if (cred.connection_status !== 'active') await markConnectionStatus(brandId, 'active', null);
    await updatePollCursor(brandId, maxSeen);

    if (totalEvents > 0) {
      console.log(`[bosta] brand ${brandId}: ${totalIngested} deliveries seen, ${totalEvents} new finance event(s)`);
    }
    return { ok: true, ingested: totalIngested, events: totalEvents };
  } catch (err) {
    await markFromError(brandId, err);
    const detail = err instanceof BostaError ? `${err.kind} (${err.status}): ${err.message}` : err.message;
    console.error(`[bosta] poll failed for brand ${brandId} — ${detail}`);
    return { ok: false, error: detail };
  }
}

/** Poll every connected brand, capped at POLL_CONCURRENCY workers. */
async function pollAllBrands() {
  const creds = await listPollableBrands();
  if (creds.length === 0) return { brands: 0, ok: 0, failed: 0 };

  const queue = [...creds];
  let ok = 0;
  let failed = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const cred = queue.shift();
      if (!cred) break;
      const res = await pollBrand(cred);
      res.ok ? ok++ : failed++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, worker));
  return { brands: creds.length, ok, failed };
}

/**
 * Onboarding first-sync: pull up to 90 days of history.
 *
 * Bosta exposes no date filter, so we paginate and filter client-side on
 * updatedAt, stopping once a page is entirely older than the window. Never full
 * history — the promise is "connect and be accurate going forward".
 *
 * Runs detached from the connect request (it can take minutes); progress lands
 * in historical_sync_state for the onboarding UI to poll.
 */
async function runHistoricalSync(brandId) {
  const cred = await getCredentials(brandId);
  if (!cred) return { ok: false, error: 'not_connected' };

  const since = new Date(Date.now() - HISTORICAL_DAYS * 86400_000).toISOString();
  let ingested = 0;
  let events = 0;
  let maxSeen = null;
  let total = null;
  let outOfWindowStreak = 0;

  await setHistoricalSyncState(brandId, { status: 'running', done: 0, total: null, started_at: new Date().toISOString() });

  try {
    await paginateDeliveries(
      cred.api_key,
      cred.env,
      async (deliveries, meta) => {
        if (total == null && meta.total != null) total = meta.total;

        const inWindow = deliveries.filter((d) => {
          const u = iso(d.updatedAt ?? d.updated_at ?? d.createdAt);
          return !u || u >= since; // undated → keep; the processor can still resolve it
        });

        if (inWindow.length > 0) {
          const res = await persistPage(brandId, inWindow, { source: 'historical' });
          ingested += res.ingested;
          events += res.events;
          if (res.maxUpdatedAt && (!maxSeen || res.maxUpdatedAt > maxSeen)) maxSeen = res.maxUpdatedAt;
        }

        await setHistoricalSyncState(brandId, { status: 'running', done: ingested, total });

        // Whole page older than the window → we've probably walked past 90 days.
        // Same unverified ordering assumption as pollBrand(), so the same
        // tolerance: require STALE_PAGE_LIMIT consecutive out-of-window pages
        // before stopping. Onboarding runs once and silently truncated history
        // is invisible afterwards, so err toward one extra page.
        outOfWindowStreak = inWindow.length === 0 ? outOfWindowStreak + 1 : 0;
        return outOfWindowStreak >= STALE_PAGE_LIMIT;
      },
      { limit: 100, maxPages: 200 }
    );

    await updatePollCursor(brandId, maxSeen);
    await setHistoricalSyncState(brandId, { status: 'done', done: ingested, total: total ?? ingested, events });
    console.log(`[bosta] historical sync complete for brand ${brandId}: ${ingested} deliveries, ${events} finance event(s)`);
    return { ok: true, ingested, events };
  } catch (err) {
    await markFromError(brandId, err);
    const detail = err instanceof BostaError ? `${err.kind}: ${err.message}` : err.message;
    await setHistoricalSyncState(brandId, { status: 'error', done: ingested, total, error: detail });
    console.error(`[bosta] historical sync failed for brand ${brandId} — ${detail}`);
    return { ok: false, error: detail };
  }
}

/**
 * Fetch one delivery on demand and ingest it (Ivy's get_delivery_status tool,
 * and a manual repair path when polling missed something).
 */
async function ingestSingleDelivery(brandId, trackingNumber) {
  const cred = await getCredentials(brandId);
  if (!cred) return { ok: false, error: 'not_connected' };

  const delivery = await getDeliveryByTracking(cred.api_key, cred.env, trackingNumber);
  if (!delivery) return { ok: false, error: 'not_found' };

  await persistPage(brandId, [delivery], { source: 'poll' });
  return { ok: true, delivery: parseDelivery(delivery) };
}

module.exports = {
  parseDelivery,
  persistPage,
  pollBrand,
  pollAllBrands,
  runHistoricalSync,
  ingestSingleDelivery,
  HISTORICAL_DAYS,
};
