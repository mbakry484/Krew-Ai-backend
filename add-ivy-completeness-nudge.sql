-- =============================================================================
-- IVY — allow the 'completeness_nudge' alert type
-- =============================================================================
-- The Ivy voice upgrade adds a weekly completeness nudge (delivered revenue
-- > EGP 20,000 in 7 days with zero opex logged → one Telegram nudge, keyed to
-- the ISO week). It rides the existing ivy_alerts machinery, so the type
-- check constraint must admit the new value.
--
-- Run in the Supabase SQL editor (idempotent).
-- =============================================================================

alter table ivy_alerts drop constraint if exists ivy_alerts_type_check;
alter table ivy_alerts add constraint ivy_alerts_type_check check (type in
  ('best_seller_low_stock','low_stock','dead_stock','return_rate_spike','pool_low','completeness_nudge'));
