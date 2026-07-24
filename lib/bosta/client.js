// =============================================================================
// BOSTA — API client
// =============================================================================
// Base URLs:
//   production  https://app.bosta.co/api/v2
//   staging     https://stg-app.bosta.co/api/v2
//
// Auth: `Authorization: <api_key>` — NO "Bearer" prefix. Bosta calls this the
// ApiKey scheme; sending "Bearer <key>" returns 401. The merchant generates the
// key in the Bosta dashboard → Settings → API Integration.
//
// Bosta supports IP whitelisting, so a 403 usually means our Railway egress IP
// isn't on the merchant's allowlist — classified separately from a bad key
// (401) because the fix is completely different (add an IP vs. reconnect).
//
// Endpoints used:
//   POST /deliveries/search                    — polling + historical sync
//   GET  /deliveries/business/{trackingNumber} — single delivery detail
//   GET  /deliveries/analytics/total-deliveries— connection test + health check
//   GET  /cities                               — reference data
//
// Deliberately NOT used: create/update/terminate delivery, pickups, AWB
// printing, pricing calculator, products. Ivy reads; the Shopify-Bosta plugin
// and Bosta's dashboard write.
// =============================================================================

const BASE_URLS = {
  production: 'https://app.bosta.co/api/v2',
  staging: 'https://stg-app.bosta.co/api/v2',
};

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 4;

/**
 * A Bosta API failure, pre-classified so callers can act without re-parsing.
 * `kind` maps 1:1 onto ivy_bosta_credentials.connection_status.
 */
class BostaError extends Error {
  constructor(message, { status = null, kind = 'error', body = null } = {}) {
    super(message);
    this.name = 'BostaError';
    this.status = status;
    this.kind = kind; // 'invalid' | 'ip_blocked' | 'rate_limited' | 'error'
    this.body = body;
  }
  get isAuth() {
    return this.kind === 'invalid' || this.kind === 'ip_blocked';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseUrl(env) {
  return BASE_URLS[env] || BASE_URLS.production;
}

/** Best-effort extraction of Bosta's own error text — shown to the founder verbatim. */
function bostaMessage(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 300);
  return (
    body.message ||
    body.error?.message ||
    body.error ||
    body.msg ||
    (Array.isArray(body.errors) && body.errors[0]?.message) ||
    fallback
  );
}

function classify(status, body) {
  const msg = bostaMessage(body, '');
  if (status === 401) return { kind: 'invalid', message: msg || 'Invalid API key' };
  if (status === 403) {
    // 403 is overloaded: IP allowlist rejection vs. a key lacking scope. The
    // remedies differ, so lean on the message when Bosta gives us one.
    const looksIp = /ip|whitelist|white-list|allow ?list|address/i.test(msg);
    return looksIp
      ? { kind: 'ip_blocked', message: msg || 'Access forbidden — IP not whitelisted' }
      : { kind: 'invalid', message: msg || 'Access forbidden' };
  }
  if (status === 429) return { kind: 'rate_limited', message: msg || 'Rate limited' };
  return { kind: 'error', message: msg || `Bosta returned ${status}` };
}

/**
 * Single HTTP call with retry/backoff on 429 and 5xx.
 * Auth failures (401/403) are NEVER retried — the key won't fix itself, and
 * hammering a whitelist-blocked endpoint is how we get the account flagged.
 */
async function request(apiKey, env, path, { method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${baseUrl(env)}${path}`;
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: apiKey, // no "Bearer" — Bosta's ApiKey scheme
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      if (res.ok) return parsed;

      const { kind, message } = classify(res.status, parsed);
      const err = new BostaError(message, { status: res.status, kind, body: parsed });

      if (err.isAuth) throw err; // terminal — do not retry
      if (attempt === MAX_RETRIES) throw err;

      // Honour Retry-After when Bosta sends one; otherwise exponential backoff
      // with jitter so concurrent brand workers don't resynchronize.
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, 16000) + Math.random() * 500;
      lastErr = err;
      await sleep(backoff);
      continue;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof BostaError) {
        if (err.isAuth || attempt === MAX_RETRIES) throw err;
        lastErr = err;
        continue;
      }
      // Network error / timeout — retry with backoff.
      lastErr = new BostaError(
        err.name === 'AbortError' ? `Bosta request timed out after ${timeoutMs}ms` : `Bosta request failed: ${err.message}`,
        { kind: 'error' }
      );
      if (attempt === MAX_RETRIES) throw lastErr;
      await sleep(Math.min(2 ** attempt * 1000, 16000) + Math.random() * 500);
    }
  }
  throw lastErr;
}

/**
 * Connection test — cheapest authenticated call Bosta exposes.
 * Returns the aggregate counts, which double as an onboarding sanity check
 * ("we can see 1,240 of your deliveries").
 */
async function getTotalDeliveries(apiKey, env) {
  const res = await request(apiKey, env, '/deliveries/analytics/total-deliveries');
  return res?.data ?? res;
}

/** Full detail for one tracking number. Returns null on 404. */
async function getDeliveryByTracking(apiKey, env, trackingNumber) {
  try {
    const res = await request(apiKey, env, `/deliveries/business/${encodeURIComponent(trackingNumber)}`);
    return res?.data ?? res;
  } catch (err) {
    if (err instanceof BostaError && err.status === 404) return null;
    throw err;
  }
}

/** Unwrap Bosta's list envelope, which has varied across versions. */
function extractList(res) {
  const d = res?.data ?? res;
  if (Array.isArray(d)) return d;
  return d?.deliveries || d?.docs || d?.list || d?.results || [];
}

/** Total result count, when Bosta reports one (used for sync progress). */
function extractTotal(res) {
  const d = res?.data ?? res;
  const total = d?.count ?? d?.total ?? d?.totalDocs ?? d?.totalCount ?? null;
  return Number.isFinite(Number(total)) ? Number(total) : null;
}

/**
 * One page of /deliveries/search.
 *
 * NOTE: we deliberately do NOT send `stateCodes`. Bosta's numeric codes are
 * unconfirmed, and a wrong code list silently returns fewer deliveries — which
 * is indistinguishable from "no sales" and would under-report revenue with no
 * error anywhere. We fetch unfiltered and filter on the state LABEL, which is
 * the stable field (see lib/bosta/stateMap.js). Costs extra pagination; buys
 * correctness we can't otherwise verify without a staging session.
 *
 * `type: 'SEND'` is safe to send — it's a documented enum, not a numeric code —
 * and isSendDelivery() re-checks every delivery anyway.
 */
async function searchDeliveriesPage(apiKey, env, { page = 1, limit = 100, businessReference = null, trackingNumbers = null } = {}) {
  const body = { type: 'SEND', page, limit };
  if (businessReference) body.businessReference = businessReference;
  if (trackingNumbers) body.trackingNumbers = trackingNumbers;

  const res = await request(apiKey, env, '/deliveries/search', { method: 'POST', body });
  return { deliveries: extractList(res), total: extractTotal(res), raw: res };
}

/**
 * Paginate /deliveries/search, yielding pages until `shouldStop(page)` returns
 * true or the results run out.
 *
 * @param {(deliveries: object[], meta: {page:number,total:number|null}) => boolean|Promise<boolean>} onPage
 *        Return true to stop paginating (e.g. cursor caught up).
 */
async function paginateDeliveries(apiKey, env, onPage, { limit = 100, maxPages = 200, ...searchOpts } = {}) {
  let page = 1;
  let fetched = 0;

  while (page <= maxPages) {
    const { deliveries, total } = await searchDeliveriesPage(apiKey, env, { ...searchOpts, page, limit });
    if (!deliveries || deliveries.length === 0) break;

    fetched += deliveries.length;
    const stop = await onPage(deliveries, { page, total });
    if (stop) break;

    // Short page = last page.
    if (deliveries.length < limit) break;
    page += 1;
  }

  return { pages: page, fetched };
}

module.exports = {
  BostaError,
  request,
  getTotalDeliveries,
  getDeliveryByTracking,
  searchDeliveriesPage,
  paginateDeliveries,
  baseUrl,
  bostaMessage,
  BASE_URLS,
};
