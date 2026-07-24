const test = require('node:test');
const assert = require('node:assert');

// =============================================================================
// IVY EXPENSE AGENT — expense_class threading (pool-tap path)
// =============================================================================
// Regression guard for the seam flagged in review: when the pool is ambiguous,
// the class chosen BEFORE the pool buttons appear is stashed in the persisted
// partial (ivy_pending_expenses.slots.partial_expense) and must survive the tap.
// finalizePoolChoice reads it back and calls ivy_log_expense — this test asserts
// the exact p_expense_class the RPC receives for each case:
//
//   partial.expense_class = 'opex'               → p_expense_class = 'opex'
//   partial.expense_class = 'inventory_purchase' → p_expense_class = 'inventory_purchase'
//   partial.expense_class = null                 → p_expense_class = null  (RPC infers from category)
//   partial.expense_class = <anything else>      → p_expense_class = null  (guard: inference still applies)
//
// A future refactor that drops the field on the way through the tap fails here.
//
// lib/supabase and lib/ai-provider both throw at import without env vars, and the
// repo has no mocking library, so we stub both in require.cache before loading the
// agent — the same zero-dependency approach as the other tests in this dir.
// =============================================================================

// ── Mutable Supabase stub (the agent captures this reference once at load) ────
const supabaseMock = {
  rpcCalls: [],
  _claimRow: null, // the ivy_pending_expenses row the claim-delete returns

  from() {
    const builder = {
      delete: () => builder,
      select: () => builder,
      insert: () => builder,
      update: () => builder,
      upsert: () => Promise.resolve({ data: null, error: null }),
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // Awaiting the chain (…​.select('slots')) resolves to the claimed rows.
      then: (resolve, reject) =>
        Promise.resolve({ data: supabaseMock._claimRow ? [supabaseMock._claimRow] : [], error: null })
          .then(resolve, reject),
    };
    return builder;
  },

  rpc(name, params) {
    supabaseMock.rpcCalls.push({ name, params });
    return Promise.resolve({ data: { ok: true, expense_id: 'exp-1', new_balance: 40000 }, error: null });
  },
};

// ── AI provider stub (renderConfirmation asks the model for one closing line) ──
const aiMock = {
  client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: '✅ logged' } }] }) } } },
  defaultModel: 'test-model',
  visionModel: 'test-vision',
  provider: 'test',
};

function stub(id, exports) {
  const filename = require.resolve(id);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../lib/supabase', supabaseMock);
stub('../lib/ai-provider', aiMock);

// Loaded AFTER the stubs so its `require('../supabase')` / `require('../ai-provider')`
// (and the same requires reached transitively) resolve to the mocks.
const { finalizePoolChoice } = require('../lib/agents/ivy-agent');

/**
 * Simulate a pool-button tap for a partial carrying `expenseClass`, returning the
 * params the RPC was called with. Fixtures are the minimum finalizePoolChoice reads.
 */
async function tapWithClass(expenseClass) {
  supabaseMock.rpcCalls = [];
  supabaseMock._claimRow = {
    slots: {
      messages: [],
      partial_expense: {
        choice_id: 'abc123',
        amount: 50000,
        category: 'inventory_materials',
        expense_class: expenseClass,
        note: 'supplier payment',
        spent_at: null,
      },
    },
  };

  const res = await finalizePoolChoice({
    chatId: 'chat-1',
    brandId: 'brand-1',
    role: 'owner',
    capitalId: 'pool-1',
    choiceId: 'abc123',
  });

  assert.equal(res.ok, true, 'tap should complete');
  assert.equal(supabaseMock.rpcCalls.length, 1, 'exactly one ivy_log_expense call');
  const { name, params } = supabaseMock.rpcCalls[0];
  assert.equal(name, 'ivy_log_expense');
  // The rest of the slot must thread through too, or the class test is hollow.
  assert.equal(params.p_brand_id, 'brand-1');
  assert.equal(params.p_amount, 50000);
  assert.equal(params.p_category, 'inventory_materials');
  assert.equal(params.p_capital_id, 'pool-1');
  return params;
}

test('opex class survives the pool tap into p_expense_class', async () => {
  const params = await tapWithClass('opex');
  assert.equal(params.p_expense_class, 'opex');
});

test('inventory_purchase class survives the pool tap into p_expense_class', async () => {
  const params = await tapWithClass('inventory_purchase');
  assert.equal(params.p_expense_class, 'inventory_purchase');
});

// The agent left the class unfilled (no ambiguity confirmation happened): the RPC
// must receive null so its category-based inference runs, not a bogus value.
test('null class passes through as null so the RPC infers from category', async () => {
  const params = await tapWithClass(null);
  assert.equal(params.p_expense_class, null);
});

// Defense in depth: anything outside the enum is normalized to null rather than
// forwarded, so a malformed slot can't write an invalid class or skip inference.
test('an out-of-enum class is coerced to null (inference still applies)', async () => {
  for (const bad of ['capex', '', 'OPEX', 'inventory']) {
    const params = await tapWithClass(bad);
    assert.equal(params.p_expense_class, null, `"${bad}" must normalize to null`);
  }
});
