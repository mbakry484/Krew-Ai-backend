#!/usr/bin/env node
/**
 * =============================================================================
 * BACKFILL — encrypt third-party credentials at rest
 * =============================================================================
 * Encrypts existing PLAINTEXT credentials in place:
 *
 *   integrations.access_token, integrations.refresh_token
 *   brands.page_access_token, brands.long_lived_user_token
 *   ivy_bosta_credentials.api_key_encrypted
 *
 * ORDER OF OPERATIONS MATTERS:
 *
 *   1. Set KREW_ENCRYPTION_KEY on the server.
 *   2. DEPLOY the decrypt-aware code FIRST. It reads plaintext and ciphertext
 *      interchangeably (lib/crypto.js passes non-"v1:" values straight through),
 *      so deploying before this backfill changes nothing at runtime.
 *   3. THEN run this script.
 *
 * Running the backfill against OLD code that doesn't decrypt would hand
 * ciphertext to Shopify/Meta and break every merchant. There is no in-band way
 * for this script to detect that, so the order is on you.
 *
 * Safe to re-run: encryptSecret() is idempotent — already-encrypted values are
 * returned untouched, so a second pass is a no-op rather than double-encryption.
 *
 * Usage:
 *   node migrate-encrypt-tokens.js --dry-run     # report only, no writes
 *   node migrate-encrypt-tokens.js               # encrypt in place
 * =============================================================================
 */

require('dotenv').config();

const supabase = require('./lib/supabase');
const { encryptSecret, isEncrypted, isEncryptionEnabled } = require('./lib/crypto');

const DRY_RUN = process.argv.includes('--dry-run');

/** One table's worth of work: which columns hold secrets. */
const TARGETS = [
  { table: 'integrations', pk: 'id', columns: ['access_token', 'refresh_token'] },
  { table: 'brands', pk: 'id', columns: ['page_access_token', 'long_lived_user_token'] },
  { table: 'ivy_bosta_credentials', pk: 'brand_id', columns: ['api_key_encrypted'] },
];

async function migrateTable({ table, pk, columns }) {
  const summary = { table, scanned: 0, encrypted: 0, alreadyEncrypted: 0, empty: 0, failed: 0 };

  const { data: rows, error } = await supabase.from(table).select([pk, ...columns].join(', '));
  if (error) {
    // A missing table isn't fatal — ivy_bosta_credentials only exists after
    // add-ivy-bosta-schema.sql has been run.
    console.error(`⚠️  ${table}: skipped (${error.message})`);
    return summary;
  }

  for (const row of rows || []) {
    summary.scanned++;
    const patch = {};

    for (const col of columns) {
      const value = row[col];
      if (value == null || value === '') continue;
      if (isEncrypted(value)) {
        summary.alreadyEncrypted++;
        continue;
      }
      patch[col] = encryptSecret(value);
    }

    if (Object.keys(patch).length === 0) {
      summary.empty++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`   • [dry-run] would encrypt ${table}.${row[pk]}: ${Object.keys(patch).join(', ')}`);
      summary.encrypted++;
      continue;
    }

    const { error: updateError } = await supabase.from(table).update(patch).eq(pk, row[pk]);
    if (updateError) {
      console.error(`   ❌ ${table}.${row[pk]}: ${updateError.message}`);
      summary.failed++;
    } else {
      console.log(`   ✅ ${table}.${row[pk]}: encrypted ${Object.keys(patch).join(', ')}`);
      summary.encrypted++;
    }
  }

  return summary;
}

async function main() {
  console.log(`\n🔐 Token encryption backfill${DRY_RUN ? ' (DRY RUN — no writes)' : ''}\n`);

  if (!isEncryptionEnabled()) {
    console.error(
      '❌ KREW_ENCRYPTION_KEY is not set (or is invalid). Without it every value would be\n' +
      '   written back as plaintext — that is a silent no-op, not a migration. Aborting.\n\n' +
      '   Generate one with:\n' +
      '     node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n'
    );
    process.exit(1);
  }

  if (!DRY_RUN) {
    console.log(
      '⚠️  This rewrites live credentials. Confirm the decrypt-aware code is ALREADY DEPLOYED\n' +
      '   before continuing — old code cannot read what this writes.\n'
    );
  }

  const summaries = [];
  for (const target of TARGETS) {
    console.log(`\n📋 ${target.table} (${target.columns.join(', ')})`);
    summaries.push(await migrateTable(target));
  }

  console.log('\n─────────────────────────────────────────');
  let failed = 0;
  for (const s of summaries) {
    console.log(
      `${s.table}: ${s.scanned} scanned · ${s.encrypted} encrypted · ` +
      `${s.alreadyEncrypted} already encrypted · ${s.empty} no secrets · ${s.failed} failed`
    );
    failed += s.failed;
  }
  console.log('─────────────────────────────────────────\n');

  if (failed > 0) {
    console.error(`❌ ${failed} row(s) failed. Re-run to retry — encryption is idempotent.`);
    process.exit(1);
  }
  console.log(DRY_RUN ? '✅ Dry run complete — no changes written.\n' : '✅ Backfill complete.\n');
}

main().catch((err) => {
  console.error('❌ Backfill crashed:', err.message);
  process.exit(1);
});
