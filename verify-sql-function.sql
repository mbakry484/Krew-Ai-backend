-- Verify if the SQL function still has the in_stock filter
-- Run this in Supabase SQL Editor

SELECT prosrc
FROM pg_proc
WHERE proname = 'match_products_by_embedding';

-- Expected output:
-- Should NOT contain: "AND products.in_stock = true"
-- Should contain: "ORDER BY products.in_stock DESC"

-- If you see "AND products.in_stock = true" in the WHERE clause,
-- then the migration hasn't been applied yet.
--
-- Run the updated SQL from MIGRATION-IMAGE-SEARCH-OOS.md to fix this!
