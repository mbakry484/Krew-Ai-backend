-- =============================================================================
-- IVY — TWO-LAYER FINANCE ENGINE + INVENTORY INTELLIGENCE · schema
-- =============================================================================
-- Run this in the Supabase SQL editor. Depends on add-ivy-schema.sql and
-- add-ivy-telegram-schema.sql having been run first (ivy_capitals,
-- ivy_expenses, expense enums, ivy_log_expense, owner_channels).
--
-- Two layers, never mixed:
--   CASH layer   (exists): pools + expenses. An inventory purchase hits cash.
--   PROFIT layer (new):    delivered revenue − COGS − opex. An inventory
--                          purchase does NOT hit profit — it drains out as
--                          COGS per delivered unit.
--
-- Brand isolation follows the existing pattern in this codebase: the backend
-- uses the Supabase service-role key and scopes every query by brand_id in the
-- API layer (see the note in add-ivy-schema.sql). RLS is therefore left off —
-- add policies before ever exposing these tables to anon-key clients.
-- =============================================================================


-- ── 1. Per-variant unit costs (append-only) ──────────────────────────────────
-- Cost changes INSERT a new row; COGS for an order uses the cost effective at
-- delivery time, which keeps historical months stable when costs change.
-- shopify_variant_id is always stored as the bare numeric id ("123456"), never
-- the gid:// form — lib/ivy/variants.js normalizes at every write site.
create table if not exists ivy_product_costs (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  shopify_variant_id text not null,
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  source text not null check (source in ('shopify','manual')),
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (brand_id, shopify_variant_id, effective_from)
);
create index if not exists idx_ivy_product_costs_lookup
  on ivy_product_costs (brand_id, shopify_variant_id, effective_from desc);


-- ── 2. Expense classification (cash vs profit layer) ─────────────────────────
-- inventory_purchase: hits cash + increases "invested in stock", EXCLUDED from
--                     the P&L (it becomes COGS per delivered unit instead).
-- opex:               hits cash + P&L this month.
alter table ivy_expenses add column if not exists expense_class text not null default 'opex'
  check (expense_class in ('opex','inventory_purchase'));

-- Backfill: inventory & materials purchases already logged are stock buys.
update ivy_expenses set expense_class = 'inventory_purchase'
  where category = 'inventory_materials' and expense_class = 'opex';


-- ── 3. Replace ivy_log_expense with an expense_class-aware version ───────────
-- Postgres would otherwise create an OVERLOAD (new arity), so drop first.
drop function if exists ivy_log_expense(uuid, numeric, expense_category, uuid, text, expense_source, timestamptz);

create or replace function ivy_log_expense(
  p_brand_id      uuid,
  p_amount        numeric,
  p_category      expense_category,
  p_capital_id    uuid,
  p_note          text,
  p_source        expense_source default 'text',
  p_spent_at      timestamptz default now(),
  p_expense_class text default null   -- null → inferred from category
) returns json
language plpgsql
as $$
declare
  v_balance     numeric;
  v_expense_id  uuid;
  v_new_balance numeric;
  v_class       text;
begin
  if p_amount is null or p_amount <= 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  v_class := coalesce(p_expense_class,
    case when p_category = 'inventory_materials' then 'inventory_purchase' else 'opex' end);
  if v_class not in ('opex','inventory_purchase') then
    return json_build_object('ok', false, 'error', 'invalid_expense_class');
  end if;

  -- lock the capital row and confirm it belongs to this brand
  select current_balance into v_balance
  from ivy_capitals
  where id = p_capital_id and brand_id = p_brand_id
  for update;

  if not found then
    return json_build_object('ok', false, 'error', 'capital_not_found');
  end if;

  insert into ivy_expenses (brand_id, amount, category, capital_id, source, note, spent_at, expense_class)
  values (p_brand_id, p_amount, p_category, p_capital_id, p_source, coalesce(p_note, ''), p_spent_at, v_class)
  returning id into v_expense_id;

  -- deduct from the stored balance (allowed to go negative)
  v_new_balance := v_balance - p_amount;
  update ivy_capitals set current_balance = v_new_balance where id = p_capital_id;

  return json_build_object(
    'ok', true,
    'expense_id', v_expense_id,
    'new_balance', v_new_balance,
    'went_negative', (v_new_balance < 0),
    'expense_class', v_class
  );
end $$;


-- ── 4. Pool transactions (money-IN ledger for cash_delta) ────────────────────
-- Money OUT is already fully recorded in ivy_expenses; this ledger records the
-- IN side (opening balances and later injections) so cash_delta for a period
-- is computable. Written by routes/ivy.js on pool create/update.
create table if not exists ivy_pool_transactions (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  capital_id uuid not null references ivy_capitals(id) on delete cascade,
  type text not null check (type in ('opening_balance','injection','withdrawal')),
  amount numeric(14,2) not null,   -- signed: withdrawal rows store a negative amount
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_ivy_pool_tx_brand_time
  on ivy_pool_transactions (brand_id, occurred_at desc);

-- Backfill: each existing pool's initial_amount becomes its opening balance,
-- timestamped at pool creation. Idempotent (skips pools already backfilled).
insert into ivy_pool_transactions (brand_id, capital_id, type, amount, occurred_at)
select c.brand_id, c.id, 'opening_balance', c.initial_amount, c.created_at
from ivy_capitals c
where not exists (
  select 1 from ivy_pool_transactions t
  where t.capital_id = c.id and t.type = 'opening_balance'
);


-- ── 5. Orders + order lines (COGS engine substrate) ──────────────────────────
-- One row per Shopify order that enters the revenue pipeline (Bosta delivery /
-- return events). COGS amounts are attributed at EVENT time: cogs_delivered is
-- booked at delivered_at, cogs_reversed at returned_at, so a January delivery
-- returned in February hits each month correctly.
create table if not exists ivy_orders (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  shopify_order_id text,              -- gid or numeric id when known
  order_number text not null,         -- e.g. "#1005" (normalized without '#')
  bosta_tracking_number text,
  delivered_value numeric(14,2) not null default 0,  -- COD/total collected at delivery
  returned_value  numeric(14,2) not null default 0,  -- value reversed on return
  cogs_delivered  numeric(14,2) not null default 0,  -- Σ qty × unit cost at delivery
  cogs_reversed   numeric(14,2) not null default 0,  -- Σ returned qty × cost at delivery
  cogs_incomplete boolean not null default false,    -- some line had no unit cost
  status text not null default 'pending'
    check (status in ('pending','delivered','returned','partially_returned')),
  delivered_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_id, order_number)
);
create index if not exists idx_ivy_orders_brand_delivered on ivy_orders (brand_id, delivered_at);
create index if not exists idx_ivy_orders_brand_returned  on ivy_orders (brand_id, returned_at);

create table if not exists ivy_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references ivy_orders(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  variant_id text not null,            -- bare numeric Shopify variant id
  qty int not null check (qty > 0),
  unit_price numeric(12,2) not null default 0,
  returned_qty int not null default 0 check (returned_qty >= 0),
  -- cost snapshot taken when the delivery event books COGS; return reversals
  -- reuse it so the reversal always matches what was booked.
  unit_cost_at_delivery numeric(12,2),
  unique (order_id, variant_id)
);
create index if not exists idx_ivy_order_lines_brand_variant on ivy_order_lines (brand_id, variant_id);


-- ── 6. Product sales velocity snapshot (nightly job output) ──────────────────
create table if not exists ivy_product_stats (
  brand_id uuid not null references brands(id) on delete cascade,
  shopify_variant_id text not null,
  velocity_30d numeric(10,3) not null default 0,   -- units/day delivered
  units_delivered_30d int not null default 0,
  revenue_30d numeric(14,2) not null default 0,
  is_best_seller boolean not null default false,   -- top 20% by 30d revenue, min 5 units
  last_sale_at timestamptz,
  computed_at timestamptz not null default now(),
  primary key (brand_id, shopify_variant_id)
);


-- ── 7. Alerts ─────────────────────────────────────────────────────────────────
create table if not exists ivy_alerts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  type text not null check (type in
    ('best_seller_low_stock','low_stock','dead_stock','return_rate_spike','pool_low')),
  severity text not null check (severity in ('critical','warning','info')),
  title text not null,
  body text not null,
  shopify_variant_id text,
  dedupe_key text not null,            -- e.g. 'best_seller_low_stock:variant123'
  status text not null default 'active' check (status in ('active','dismissed','resolved')),
  telegram_sent_at timestamptz,
  created_at timestamptz not null default now()
);
-- One ACTIVE alert per condition; dismissed/resolved history is kept.
create unique index if not exists idx_ivy_alerts_active_dedupe
  on ivy_alerts (brand_id, dedupe_key) where status = 'active';
create index if not exists idx_ivy_alerts_brand_status on ivy_alerts (brand_id, status, created_at desc);


-- ── 8. Alert preferences (one row per brand, created lazily with defaults) ────
create table if not exists ivy_alert_preferences (
  brand_id uuid primary key references brands(id) on delete cascade,
  best_seller_low_stock jsonb not null default '{"enabled":true,"thresholdDays":7}',
  any_low_stock jsonb not null default '{"enabled":true,"thresholdDays":5}',
  dead_stock jsonb not null default '{"enabled":true,"thresholdDays":60}',
  return_rate_spike jsonb not null default '{"enabled":true,"thresholdPts":5}',
  pool_low jsonb not null default '{"enabled":false,"thresholdEgp":10000}'
);


-- ── 9. Onboarding flag ────────────────────────────────────────────────────────
alter table brands add column if not exists ivy_onboarding_completed boolean not null default false;


-- ── 10. Profit summary RPC ────────────────────────────────────────────────────
-- The single source of truth for "was this period actually good?".
--   net_revenue     = delivered − returned (event-time attributed)
--   cogs            = cogs booked at delivery − reversals booked at return
--   opex            = expenses where expense_class = 'opex'
--   real_net_profit = net_revenue − cogs − opex
--   cash_delta      = pool money-in (tx ledger) − ALL expenses (both classes)
--   cost_coverage   = % of in-stock variants that have a unit cost
create or replace function ivy_profit_summary(
  p_brand_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns json
language plpgsql
stable
as $$
declare
  v_delivered numeric := 0;
  v_returned numeric := 0;
  v_cogs_delivered numeric := 0;
  v_cogs_reversed numeric := 0;
  v_cogs_incomplete_orders int := 0;
  v_opex numeric := 0;
  v_inventory_spend numeric := 0;
  v_money_in numeric := 0;
  v_money_out numeric := 0;
  v_variants_with_stock int := 0;
  v_variants_costed int := 0;
begin
  select coalesce(sum(delivered_value), 0), coalesce(sum(cogs_delivered), 0),
         count(*) filter (where cogs_incomplete)
    into v_delivered, v_cogs_delivered, v_cogs_incomplete_orders
  from ivy_orders
  where brand_id = p_brand_id and delivered_at >= p_from and delivered_at < p_to;

  select coalesce(sum(returned_value), 0), coalesce(sum(cogs_reversed), 0)
    into v_returned, v_cogs_reversed
  from ivy_orders
  where brand_id = p_brand_id and returned_at >= p_from and returned_at < p_to;

  select coalesce(sum(amount) filter (where expense_class = 'opex'), 0),
         coalesce(sum(amount) filter (where expense_class = 'inventory_purchase'), 0),
         coalesce(sum(amount), 0)
    into v_opex, v_inventory_spend, v_money_out
  from ivy_expenses
  where brand_id = p_brand_id and spent_at >= p_from and spent_at < p_to;

  select coalesce(sum(amount), 0) into v_money_in
  from ivy_pool_transactions
  where brand_id = p_brand_id and occurred_at >= p_from and occurred_at < p_to;

  -- Cost coverage over CURRENT stock (not period-bound): distinct in-stock
  -- variants across the product cache vs how many have any unit cost row.
  with vars as (
    select distinct
      case when (v->>'id') like 'gid://%' then split_part(v->>'id', '/', 5) else (v->>'id') end as vid
    from products p, jsonb_array_elements(coalesce(p.variants, '[]'::jsonb)) v
    where p.brand_id = p_brand_id
      and coalesce((v->>'inventoryQuantity')::int, (v->>'inventory_quantity')::int, 0) > 0
  )
  select count(*), count(*) filter (where exists (
           select 1 from ivy_product_costs c
           where c.brand_id = p_brand_id and c.shopify_variant_id = vars.vid))
    into v_variants_with_stock, v_variants_costed
  from vars;

  return json_build_object(
    'net_revenue', v_delivered - v_returned,
    'gross_delivered', v_delivered,
    'returns', v_returned,
    'return_rate_pct', case when v_delivered > 0 then round(v_returned / v_delivered * 100, 1) else 0 end,
    'cogs', v_cogs_delivered - v_cogs_reversed,
    'cogs_incomplete_orders', v_cogs_incomplete_orders,
    'opex', v_opex,
    'inventory_spend', v_inventory_spend,
    'real_net_profit', (v_delivered - v_returned) - (v_cogs_delivered - v_cogs_reversed) - v_opex,
    'cash_delta', v_money_in - v_money_out,
    'cost_coverage_pct', case when v_variants_with_stock > 0
      then round(v_variants_costed::numeric / v_variants_with_stock * 100, 1) else 0 end
  );
end $$;
