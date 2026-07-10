/**
 * One-off migration: rotate legacy non-expiring Shopify offline tokens into
 * expiring offline tokens (+ refresh tokens) via Shopify's token exchange.
 *
 * Usage:
 *   node migrate-legacy-shopify-tokens.js --dry-run   # list affected shops, no writes
 *   node migrate-legacy-shopify-tokens.js             # perform the migration
 *
 * Requires the same env as the server: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * SHOPIFY_API_KEY, SHOPIFY_API_SECRET. Safe to re-run — migrated rows are skipped.
 */

require('dotenv').config();
const { migrateLegacyShopifyTokens } = require('./lib/shopify');

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');

(async () => {
  console.log(`\n🚀 Legacy Shopify token migration ${dryRun ? '(DRY RUN — no changes will be made)' : '(LIVE)'}`);
  try {
    const summary = await migrateLegacyShopifyTokens({ dryRun });
    // Non-zero exit if any shop failed, so CI / operators notice.
    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n💥 Migration aborted:', err.message);
    process.exit(2);
  }
})();
