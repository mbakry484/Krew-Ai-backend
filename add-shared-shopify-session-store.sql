-- Shared Shopify token store: the embedded app's SDK session storage now
-- reads/writes the SAME integrations row the backend uses, so there is one
-- offline token lineage per app+store (Shopify's rule).
--
-- Run order:
--   1. Run the PRE-CHECK select alone. It must return zero rows; if it
--      returns duplicates, dedupe them manually before continuing.
--   2. Run the rest of this file.
--   3. Deploy backend, then the embedded app (with SUPABASE_URL /
--      SUPABASE_SERVICE_ROLE_KEY set), THEN delete the app's Prisma Session
--      rows (on the APP's Railway Postgres, not Supabase):
--        DELETE FROM "Session";

-- 0. PRE-CHECK: rows that would violate the composite unique index.
SELECT platform, shopify_shop_domain, COUNT(*) AS n, array_agg(id) AS ids
FROM integrations
WHERE shopify_shop_domain IS NOT NULL
GROUP BY platform, shopify_shop_domain
HAVING COUNT(*) > 1;

-- 1. SDK session fields that have no existing column (id, state, scope).
--    Tokens stay in the canonical access_token/refresh_token columns.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS shopify_session JSONB;
COMMENT ON COLUMN integrations.shopify_session IS
  'Shopify SDK offline-session metadata (id/state/scope); tokens live in access_token / refresh_token columns';

-- 2. Race-safe upsert target for both the app's session adapter and the
--    backend's OAuth callback. Full (non-partial) index so PostgREST
--    ON CONFLICT inference always works. Instagram rows have a NULL domain
--    and never collide (NULLs are distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_platform_shop_domain
  ON integrations (platform, shopify_shop_domain);
