const test = require('node:test');
const assert = require('node:assert');

const {
  eventForLabel,
  isFinanceEvent,
  isSendDelivery,
  stateLabelOf,
  stateCodeOf,
  EVENT_DELIVERED,
  EVENT_RETURNED,
  EVENT_CANCELLED,
  EVENT_STATE_CHANGE,
} = require('../lib/bosta/stateMap');

// =============================================================================
// The build doc asked for tests asserting on both `code` and `value`. We assert
// on the LABEL and — just as important — assert that the numeric code has NO
// influence, because the codes in the doc were an example and are unconfirmed.
// If someone later "optimizes" by branching on code, these tests fail.
// =============================================================================

test('delivered labels book revenue', () => {
  for (const label of ['Delivered', 'delivered', 'DELIVERED', '  Delivered  ', 'Completed']) {
    assert.equal(eventForLabel(label).event, EVENT_DELIVERED, `expected delivered for "${label}"`);
  }
});

test('return labels reverse revenue', () => {
  for (const label of ['Returned to business', 'Returned', 'Return to business', 'returned_to_business']) {
    assert.equal(eventForLabel(label).event, EVENT_RETURNED, `expected returned for "${label}"`);
  }
});

test('terminal/cancel labels map to cancelled', () => {
  for (const label of ['Terminated', 'Cancelled', 'Canceled']) {
    assert.equal(eventForLabel(label).event, EVENT_CANCELLED, `expected cancelled for "${label}"`);
  }
});

// The whole reason exact-match runs before fuzzy matching. "Out for delivery"
// contains "deliver"; booking revenue on it would count money for a package
// still on the van — and every one of these would look like a real sale.
test('in-flight labels that LOOK like finance events do not move money', () => {
  const inFlight = [
    'Out for delivery',
    'Out for return',
    'Returning to origin',
    'Delivery failed',
    'Pickup requested',
    'Picked up',
    'In transit',
    'On hold',
    'Awaiting your action',
    'Route assigned',
    'Received at warehouse',
    'Exception',
    'Lost',
    'Damaged',
  ];
  for (const label of inFlight) {
    assert.equal(eventForLabel(label).event, EVENT_STATE_CHANGE, `"${label}" must NOT be a finance event`);
    assert.equal(isFinanceEvent(label), false, `"${label}" must NOT be a finance event`);
  }
});

test('unknown labels are feed-only and flagged as unknown', () => {
  const res = eventForLabel('Teleported to customer');
  assert.equal(res.event, EVENT_STATE_CHANGE);
  assert.equal(res.known, false, 'unknown labels must be flagged so they surface in logs');
});

test('empty/missing labels never book money', () => {
  for (const label of ['', null, undefined, '   ']) {
    const res = eventForLabel(label);
    assert.equal(res.event, EVENT_STATE_CHANGE);
    assert.equal(res.known, false);
  }
});

test('fuzzy wording drift still resolves correctly', () => {
  // Labels Bosta might plausibly reword to — the fuzzy rules should cope.
  assert.equal(eventForLabel('Package delivered to customer').event, EVENT_DELIVERED);
  assert.equal(eventForLabel('Returned to seller').event, EVENT_RETURNED);
  assert.equal(eventForLabel('Delivery attempted').event, EVENT_STATE_CHANGE); // attempt ≠ delivered
  assert.equal(eventForLabel('Return requested').event, EVENT_STATE_CHANGE);   // requested ≠ returned
});

test('state code has NO influence on the event — label is the only input', () => {
  // Same label, wildly different codes: the mapping must not budge.
  for (const code of [0, 10, 45, 46, 47, 49, 999, -1]) {
    assert.equal(
      eventForLabel('Delivered').event,
      EVENT_DELIVERED,
      `code ${code} must not change how the "Delivered" label maps`
    );
  }
  // And a delivered CODE with an in-flight LABEL must follow the label.
  const delivery = { state: { code: 45, value: 'Out for delivery' } };
  assert.equal(eventForLabel(stateLabelOf(delivery)).event, EVENT_STATE_CHANGE);
});

test('stateLabelOf tolerates Bosta shape drift', () => {
  assert.equal(stateLabelOf({ state: { value: 'Delivered' } }), 'Delivered');
  assert.equal(stateLabelOf({ state: 'Delivered' }), 'Delivered');
  assert.equal(stateLabelOf({ state: { state: 'Delivered' } }), 'Delivered');
  assert.equal(stateLabelOf({ deliveryState: 'Delivered' }), 'Delivered');
  assert.equal(stateLabelOf({}), null);
});

test('stateCodeOf extracts a code for display, null when absent', () => {
  assert.equal(stateCodeOf({ state: { code: 45 } }), 45);
  assert.equal(stateCodeOf({ stateCode: 10 }), 10);
  assert.equal(stateCodeOf({ state: {} }), null);
  assert.equal(stateCodeOf({}), null);
});

// Only SEND deliveries are revenue. Cash-collection / CRP / exchange must never
// reach the COGS engine — the doc calls for a hard guard.
test('isSendDelivery accepts SEND by label', () => {
  assert.equal(isSendDelivery({ type: { value: 'Send', code: 10 } }), true);
  assert.equal(isSendDelivery({ type: { value: 'SEND' } }), true);
  assert.equal(isSendDelivery({ type: 'Send' }), true);
});

test('isSendDelivery rejects non-SEND types', () => {
  assert.equal(isSendDelivery({ type: { value: 'Cash Collection', code: 15 } }), false);
  assert.equal(isSendDelivery({ type: { value: 'Exchange', code: 30 } }), false);
  assert.equal(isSendDelivery({ type: { value: 'CRP', code: 25 } }), false);
});

test('isSendDelivery falls back to code 10 ONLY when no label exists', () => {
  assert.equal(isSendDelivery({ type: { code: 10 } }), true);
  assert.equal(isSendDelivery({ type: { code: 15 } }), false);
  // Label present and non-SEND wins over a SEND code — label is authoritative.
  assert.equal(isSendDelivery({ type: { value: 'Exchange', code: 10 } }), false);
  // Nothing to go on → not SEND. Fail closed: never book revenue on a guess.
  assert.equal(isSendDelivery({}), false);
  assert.equal(isSendDelivery({ type: {} }), false);
});
