// =============================================================================
// BOSTA — delivery state → Ivy finance event
// =============================================================================
// Bosta reports state as a pair: state.code (number) and state.value (string).
// This module maps ONLY the string label. Numeric codes are stored on
// ivy_deliveries for display/debugging but never drive behaviour, because:
//
//   1. Bosta's numeric codes are unconfirmed and have drifted across API
//      versions; the labels are the stable contract.
//   2. Codes are never used to FETCH either (we don't send stateCodes to
//      /deliveries/search — see lib/bosta/client.js). A wrong code list would
//      silently omit deliveries from the search response, which looks exactly
//      like "no sales" rather than like a bug. Label filtering fails loudly
//      instead: an unrecognized label shows up in the unknown-label log.
//
// Finance events (everything else is feed-only, no P&L effect):
//
//   delivered  → +revenue, +COGS   (booked at delivery time)
//   returned   → reverse both      (booked at return time)
//   cancelled  → reverse if it had been delivered; ignore if never delivered
//
// ⚠️ Matching hazard: "Out for delivery" contains "deliver" and "Out for
// return" contains "return". Substring matching on those labels books revenue
// on a van that hasn't arrived. Exact matching is the primary path; the fuzzy
// fallback carries explicit negative guards and is ordered most-specific-first.
// =============================================================================

const EVENT_DELIVERED = 'delivered';
const EVENT_RETURNED = 'returned';
const EVENT_CANCELLED = 'cancelled';
const EVENT_STATE_CHANGE = 'state_change';

/** Collapse a raw Bosta label to a comparable key: lowercase, single-spaced. */
function canonical(label) {
  return String(label == null ? '' : label).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

// Exact label → event. Keys are canonical()-form. Labels observed across Bosta's
// spec + dashboard; the fuzzy fallback covers wording drift.
const EXACT_LABELS = new Map([
  // ── Finance-relevant ──
  ['delivered', EVENT_DELIVERED],
  ['completed', EVENT_DELIVERED],
  ['returned to business', EVENT_RETURNED],
  ['return to business', EVENT_RETURNED],
  ['returned', EVENT_RETURNED],
  ['terminated', EVENT_CANCELLED],
  ['cancelled', EVENT_CANCELLED],
  ['canceled', EVENT_CANCELLED],

  // ── Feed-only: in-flight ──
  ['pickup requested', EVENT_STATE_CHANGE],
  ['route assigned', EVENT_STATE_CHANGE],
  ['picked up', EVENT_STATE_CHANGE],
  ['picked up from business', EVENT_STATE_CHANGE],
  ['received at warehouse', EVENT_STATE_CHANGE],
  ['in transit', EVENT_STATE_CHANGE],
  ['out for delivery', EVENT_STATE_CHANGE],
  ['out for return', EVENT_STATE_CHANGE],
  ['returning to origin', EVENT_STATE_CHANGE],
  ['delivery failed', EVENT_STATE_CHANGE],
  ['exception', EVENT_STATE_CHANGE],
  ['on hold', EVENT_STATE_CHANGE],
  ['awaiting action', EVENT_STATE_CHANGE],
  ['awaiting your action', EVENT_STATE_CHANGE],
  ['lost', EVENT_STATE_CHANGE],
  ['damaged', EVENT_STATE_CHANGE],
  ['archived', EVENT_STATE_CHANGE],
]);

// Ordered fuzzy rules for labels not matched exactly. First match wins, so the
// in-flight exclusions MUST come before the finance rules they'd otherwise be
// swallowed by.
const FUZZY_RULES = [
  // ── Exclusions first: these look like finance events but aren't ──
  { test: (s) => s.includes('out for'), event: EVENT_STATE_CHANGE },        // out for delivery/return
  { test: (s) => s.includes('failed') || s.includes('fail'), event: EVENT_STATE_CHANGE },
  { test: (s) => s.includes('returning'), event: EVENT_STATE_CHANGE },      // returning to origin — in flight
  { test: (s) => s.includes('attempt'), event: EVENT_STATE_CHANGE },        // delivery attempted
  { test: (s) => s.includes('request'), event: EVENT_STATE_CHANGE },        // return requested / pickup requested

  // ── Finance rules ──
  { test: (s) => s.includes('return'), event: EVENT_RETURNED },
  { test: (s) => s.includes('deliver'), event: EVENT_DELIVERED },
  { test: (s) => s.includes('terminat') || s.includes('cancel'), event: EVENT_CANCELLED },
];

/**
 * Map a Bosta state label to an Ivy event.
 * @returns {{event: string, known: boolean}} `known: false` means neither the
 *   exact map nor the fuzzy rules matched — treated as a feed-only state_change
 *   and logged, so a new Bosta label surfaces instead of silently misbooking.
 */
function eventForLabel(label) {
  const s = canonical(label);
  if (!s) return { event: EVENT_STATE_CHANGE, known: false };

  const exact = EXACT_LABELS.get(s);
  if (exact) return { event: exact, known: true };

  for (const rule of FUZZY_RULES) {
    if (rule.test(s)) return { event: rule.event, known: true };
  }

  return { event: EVENT_STATE_CHANGE, known: false };
}

/** Does this label move money? */
function isFinanceEvent(label) {
  const { event } = eventForLabel(label);
  return event !== EVENT_STATE_CHANGE;
}

// ── Delivery type ────────────────────────────────────────────────────────────
// Only SEND deliveries produce revenue. Cash-collection, CRP and exchange are
// out of scope for v1 and must never reach the COGS engine. Same rule as state:
// match the label, treat the code as advisory.
function isSendDelivery(delivery) {
  // `delivery.type` is either { value, code } or a bare string. Only treat it as
  // a label when it IS one — passing the object to canonical() stringifies it to
  // "[object Object]", which is truthy and would shadow the code fallback below,
  // silently marking every unlabelled SEND delivery as non-SEND (i.e. no revenue).
  const typeValue = delivery?.type?.value ?? (typeof delivery?.type === 'string' ? delivery.type : null);
  const rawLabel = canonical(typeValue ?? '');
  if (rawLabel) return rawLabel === 'send';

  // No label — fall back to the code Bosta documents for SEND (10). This is the
  // one place a code is consulted, and only when the label is absent entirely.
  const code = Number(delivery?.type?.code);
  return Number.isFinite(code) ? code === 10 : false;
}

/** Pull the state label out of a delivery payload, tolerating shape drift. */
function stateLabelOf(delivery) {
  return (
    delivery?.state?.value ??
    delivery?.state?.state ??
    (typeof delivery?.state === 'string' ? delivery.state : null) ??
    delivery?.deliveryState ??
    delivery?.state?.name ??
    null
  );
}

/** Numeric state code, for storage/display only. */
function stateCodeOf(delivery) {
  const code = Number(delivery?.state?.code ?? delivery?.stateCode);
  return Number.isFinite(code) ? code : null;
}

module.exports = {
  eventForLabel,
  isFinanceEvent,
  isSendDelivery,
  stateLabelOf,
  stateCodeOf,
  canonical,
  EVENT_DELIVERED,
  EVENT_RETURNED,
  EVENT_CANCELLED,
  EVENT_STATE_CHANGE,
};
