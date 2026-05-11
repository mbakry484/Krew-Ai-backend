const cron = require('node-cron');
const { getBrandsWithExpiringTokens, refreshPageToken } = require('../src/services/metaTokenService');

/**
 * Daily token refresh cron job.
 * Runs at midnight every day (00:00).
 * 
 * Checks for brands whose long-lived user token is expiring within 7 days
 * and proactively refreshes their page tokens.
 */
function startTokenRefreshCron() {
  console.log('⏰ Token refresh cron job scheduled (daily at midnight)');

  cron.schedule('0 0 * * *', async () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Running daily token refresh check...');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const expiringBrands = await getBrandsWithExpiringTokens(7);

      if (expiringBrands.length === 0) {
        console.log('✅ No tokens expiring within 7 days. All good!');
        return;
      }

      console.log(`⚠️  Found ${expiringBrands.length} brand(s) with expiring tokens:`);

      let successCount = 0;
      let failCount = 0;

      for (const brand of expiringBrands) {
        try {
          console.log(`   🔄 Refreshing brand ${brand.id} (expires: ${brand.token_expires_at})...`);
          await refreshPageToken(brand.id);
          successCount++;
          console.log(`   ✅ Brand ${brand.id} refreshed successfully`);
        } catch (error) {
          failCount++;
          console.error(`   ❌ Brand ${brand.id} refresh FAILED: ${error.message}`);
        }
      }

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`🏁 Token refresh complete: ${successCount} success, ${failCount} failed`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    } catch (error) {
      console.error('❌ Token refresh cron error:', error.message);
    }
  });
}

module.exports = { startTokenRefreshCron };
