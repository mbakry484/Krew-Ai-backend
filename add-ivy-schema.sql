-- =============================================================================
-- IVY — FINANCIAL VISIBILITY · schema (Capitals + Expenses only)
-- =============================================================================
-- Run this in the Supabase SQL editor.
--
-- Scope: this migration creates only the two tables that are wired to the
-- backend right now — capital pools and operating expenses. Revenue channels,
-- revenue snapshots, inventory, and targets are served as dummy shapes by the
-- API and are intentionally NOT created here yet.
--
-- Money is stored as numeric EGP amounts (not cents). current_balance is kept
-- on the row but the API recomputes it on read as:
--   current_balance = initial_amount − Σ(expenses.amount for that pool)
--
-- Brand isolation is enforced in the API layer (the backend uses the Supabase
-- service-role key and scopes every query by brand_id), matching the rest of
-- this codebase. RLS is therefore left off here — add it later if you move to
-- anon-key access from the client.
-- =============================================================================

-- ── Enums ────────────────────────────────────────────────────────────────────
do $$ begin
  create type expense_category as enum (
    'inventory_materials','marketing_ads','shipping_fulfillment','salaries',
    'packaging','software','rent_utilities','fees_commissions','other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type expense_source as enum ('text','voice','receipt');
exception when duplicate_object then null; end $$;

do $$ begin
  create type capital_color as enum ('teal','obsidian','silver','copper','indigo','rose');
exception when duplicate_object then null; end $$;

-- ── Capital pools ────────────────────────────────────────────────────────────
-- Pots of injected money that expenses deduct from.
create table if not exists ivy_capitals (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references brands(id) on delete cascade,
  name            text not null,
  initial_amount  numeric(14,2) not null check (initial_amount >= 0),
  current_balance numeric(14,2) not null,        -- recomputed on read by the API
  color           capital_color not null default 'teal',
  created_at      timestamptz not null default now()
);

-- ── Operating expenses ───────────────────────────────────────────────────────
-- Each expense deducts from exactly one capital pool. on delete restrict makes
-- the DB refuse to drop a pool that still has expenses (API returns 409).
create table if not exists ivy_expenses (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references brands(id) on delete cascade,
  amount      numeric(14,2) not null check (amount > 0),
  category    expense_category not null,
  capital_id  uuid not null references ivy_capitals(id) on delete restrict,
  source      expense_source not null default 'text',
  note        text not null default '',
  spent_at    timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists idx_ivy_capitals_brand_id on ivy_capitals (brand_id);
create index if not exists idx_ivy_expenses_brand_spent on ivy_expenses (brand_id, spent_at desc);
create index if not exists idx_ivy_expenses_capital_id on ivy_expenses (capital_id);
