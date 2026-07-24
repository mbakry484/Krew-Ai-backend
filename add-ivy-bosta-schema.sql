-- =============================================================================
-- IVY — BOSTA INGESTION (credentials, deliveries, events) · schema
-- =============================================================================
-- Run in the Supabase SQL editor. Depends on add-ivy-profit-inventory-schema.sql
-- (ivy_orders, ivy_order_lines, ivy_product_costs, ivy_profit_summary).
--
-- Bosta is the source of truth for revenue and returns. Ivy does NOT create
-- deliveries — the founder ships via the Shopify-Bosta plugin or the Bosta
-- dashboard. Ivy READS their deliveries and turns state changes into revenue,
-- returns and COGS events.
--
-- Because we don't create deliveries, we cannot register a webhook URL on them
-- (Bosta webhooks are per-delivery, set at creation). POLLING is therefore the
-- primary ingestion path; the webhook endpoint exists only to cleanly accept
-- deliveries a future Krew-created flow might register.
--
-- Brand isolation follows this codebase's established pattern: service-role key
-- + brand_id scoping in the API layer. RLS is intentionally NOT enabled here
-- (see the same note in add-ivy-schema.sql / add-ivy-profit-inventory-schema.sql).
-- Add policies before ever exposing these tables to anon-key clients.
-- =============================================================================


-- ── 1. Per-brand Bosta credentials + polling state ───────────────────────────
-- Supersedes the integrations row with platform='bosta' (which parked the API
-- key unused). Section 6 migrates any existing key across and drops those rows.
--
-- api_key_encrypted holds an AES-256-GCM envelope from lib/crypto.js
-- ("v1:<iv>:<tag>:<ciphertext>"). Legacy plaintext reads back unchanged, so the
-- column tolerates both shapes during rollout.
create table if not exists ivy_bosta_credentials (
  brand_id uuid primary key references brands(id) on delete cascade,
  api_key_encrypted text not null,
  env text not null default 'production' check (env in ('production','staging')),
  webhook_secret text not null,              -- for future Krew-created deliveries
  webhook_configured_at timestamptz,
  last_poll_at timestamptz,                  -- when we last completed a poll
  last_poll_cursor timestamptz,              -- max delivery updatedAt ingested
  historical_sync_completed_at timestamptz,
  historical_sync_state jsonb,               -- {status,total,done,error} for onboarding UI
  connection_status text not null default 'active'
    check (connection_status in ('active','invalid','ip_blocked','error')),
  connection_error text,                     -- last error verbatim from Bosta, for the UI
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ivy_bosta_creds_polling
  on ivy_bosta_credentials (connection_status, last_poll_at);


-- ── 2. Deliveries (one row per Bosta delivery, current state) ────────────────
-- The activity-feed / lookup mirror of Bosta. Finance effects are NOT computed
-- here — they live in ivy_orders via lib/ivy/cogs.js. state_label is the field
-- finance logic keys off; state_code is stored for display/debugging only and
-- is deliberately never used to drive behaviour (Bosta's numeric codes are
-- unconfirmed and their labels are the stable contract).
create table if not exists ivy_deliveries (
  brand_id uuid not null references brands(id) on delete cascade,
  bosta_delivery_id text not null,           -- Bosta's _id
  tracking_number text,
  business_reference text,
  unique_business_reference text,
  shopify_order_id text,
  order_number text,                         -- resolved Shopify order number
  state_code int,                            -- display only — never branch on this
  state_label text,                          -- normalized label → finance events
  state_value_raw text,                      -- full state.value verbatim
  delivery_type_code int,                    -- 10=SEND, 15=CC, 25=CRP, 30=EXCHANGE
  delivery_type_raw text,
  cod_amount numeric(12,2),
  goods_amount numeric(12,2),                -- goodsInfo.amount — preferred for revenue
  shipment_fees numeric(12,2),               -- Bosta's fee — drives payout reconciliation
  city_name text,
  zone_name text,
  first_delivered_at timestamptz,            -- first delivery ever seen (never overwritten)
  returned_at timestamptz,
  cancelled_at timestamptz,
  bosta_updated_at timestamptz,              -- Bosta's updatedAt — the poll cursor source
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (brand_id, bosta_delivery_id)
);
create index if not exists idx_ivy_deliveries_delivered on ivy_deliveries (brand_id, first_delivered_at);
create index if not exists idx_ivy_deliveries_returned  on ivy_deliveries (brand_id, returned_at);
create index if not exists idx_ivy_deliveries_busref    on ivy_deliveries (business_reference);
create index if not exists idx_ivy_deliveries_uniqref   on ivy_deliveries (unique_business_reference);
create index if not exists idx_ivy_deliveries_tracking  on ivy_deliveries (brand_id, tracking_number);


-- ── 3. Event queue (append-only; polling + webhook both land here) ───────────
-- The unique constraint is what makes polling and webhooks safely redundant:
-- whichever sees a state change first wins, the other is a no-op insert.
create table if not exists ivy_bosta_events (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  bosta_delivery_id text not null,
  event_type text not null check (event_type in ('delivered','returned','cancelled','state_change')),
  from_state text,
  to_state text,
  occurred_at timestamptz not null,
  processed_at timestamptz,
  process_error text,
  attempts int not null default 0,
  source text not null default 'poll' check (source in ('poll','webhook','historical')),
  raw jsonb not null,
  created_at timestamptz not null default now(),
  unique (brand_id, bosta_delivery_id, event_type, occurred_at)
);
-- The processor's hot path: unprocessed events in occurred_at order.
create index if not exists idx_ivy_bosta_events_unprocessed
  on ivy_bosta_events (occurred_at) where processed_at is null;


-- ── 4. ivy_orders additions for Bosta reconciliation ─────────────────────────
-- shipment_fees: Bosta's per-delivery fee, needed for expected-payout maths.
-- cod_collected: what Bosta actually collected (may include shipping), kept
--   distinct from delivered_value which prefers goodsInfo.amount (item value).
alter table ivy_orders add column if not exists shipment_fees numeric(12,2) not null default 0;
alter table ivy_orders add column if not exists cod_collected numeric(12,2) not null default 0;


-- ── 5. Unmatched deliveries view (COD counted, COGS unknown) ─────────────────
-- A delivery whose businessReference doesn't resolve to a Shopify order still
-- counts as revenue — we just can't attribute COGS. Surfaced so the founder can
-- fix the reference rather than silently lose margin accuracy.
create or replace view unmatched_bosta_deliveries as
select d.brand_id,
       d.bosta_delivery_id,
       d.tracking_number,
       coalesce(d.business_reference, d.unique_business_reference) as reference,
       d.state_label,
       d.cod_amount,
       d.goods_amount,
       d.first_delivered_at
from ivy_deliveries d
where d.first_delivered_at is not null
  and d.order_number is null;


-- ── 6. Migrate the parked API key off integrations, then drop those rows ─────
-- routes/integrations.js used to store the Bosta key as platform='bosta' with
-- the key unused. Move any existing key into the new table so connected brands
-- don't have to reconnect. Keys land as PLAINTEXT here; lib/crypto.js reads
-- plaintext transparently, and migrate-encrypt-tokens.js encrypts them in place.
insert into ivy_bosta_credentials (brand_id, api_key_encrypted, webhook_secret, connection_status)
select i.brand_id,
       i.access_token,
       encode(gen_random_bytes(32), 'hex'),
       'active'
from integrations i
where i.platform = 'bosta'
  and i.brand_id is not null
  and coalesce(i.access_token, '') <> ''
on conflict (brand_id) do nothing;

delete from integrations where platform = 'bosta';
