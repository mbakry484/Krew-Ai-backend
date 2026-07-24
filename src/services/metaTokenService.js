const supabase = require('../../lib/supabase');
const { encryptSecret, decryptSecret } = require('../../lib/crypto');

const INSTAGRAM_GRAPH_BASE = 'https://graph.instagram.com';

// Instagram tokens are encrypted at rest (lib/crypto.js). getValidPageToken and
// refreshPageToken are the read boundaries — they return PLAINTEXT, so every
// caller (webhook DM flow, cron, routes) keeps working unchanged. Writes encrypt.

/**
 * Refresh a long-lived Instagram user token.
 * Instagram long-lived tokens can be refreshed as long as they are at least 24h old
 * and not yet expired. The refreshed token is valid for another 60 days.
 * @param {string} currentToken - The current long-lived Instagram user token
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
async function refreshLongLivedToken(currentToken) {
  const url = `${INSTAGRAM_GRAPH_BASE}/refresh_access_token`
    + `?grant_type=ig_refresh_token`
    + `&access_token=${currentToken}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    const msg = data.error?.message || 'Unknown error';
    throw new Error(`Failed to refresh Instagram token: ${msg}`);
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in || 5184000 // default 60 days
  };
}

/**
 * Sync the Instagram user token to the integrations table.
 * This ensures the webhook flow uses the fresh token.
 * @param {string} brandId
 * @param {string} accessToken
 */
async function syncTokenToIntegrations(brandId, accessToken) {
  const { error } = await supabase
    .from('integrations')
    .update({ access_token: encryptSecret(accessToken) })
    .eq('brand_id', brandId)
    .eq('platform', 'instagram');

  if (error) {
    console.error(`⚠️  [${brandId}] Failed to sync token to integrations table: ${error.message}`);
  } else {
    console.log(`🔄 [${brandId}] Token synced to integrations table`);
  }
}

/**
 * Refresh the Instagram user token for a brand and save the new token.
 * Updates both the brands table and integrations table.
 * @param {string} brandId - Brand ID in Supabase
 * @returns {Promise<string>} The fresh Instagram user token
 */
async function refreshPageToken(brandId) {
  console.log(`🔄 [${brandId}] Refreshing Instagram user token...`);

  const { data: brand, error: fetchError } = await supabase
    .from('brands')
    .select('long_lived_user_token, token_expires_at')
    .eq('id', brandId)
    .single();

  if (fetchError || !brand) {
    throw new Error(`Brand ${brandId} not found: ${fetchError?.message || 'not found'}`);
  }

  if (!brand.long_lived_user_token) {
    throw new Error(`Brand ${brandId} has no Instagram user token. Run the OAuth flow first.`);
  }

  // Refresh the long-lived token for another 60 days
  const { access_token: freshToken, expires_in } = await refreshLongLivedToken(decryptSecret(brand.long_lived_user_token));
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  // Save the refreshed token to brands table (encrypted at rest)
  const encrypted = encryptSecret(freshToken);
  const { error: updateError } = await supabase
    .from('brands')
    .update({
      page_access_token: encrypted,
      long_lived_user_token: encrypted,
      token_expires_at: expiresAt
    })
    .eq('id', brandId);

  if (updateError) {
    throw new Error(`Failed to save refreshed token for brand ${brandId}: ${updateError.message}`);
  }

  // Sync to integrations table
  await syncTokenToIntegrations(brandId, freshToken);

  console.log(`✅ [${brandId}] Instagram user token refreshed (expires ${expiresAt})`);
  return freshToken;
}

/**
 * Get a valid Instagram user token for a brand.
 * Checks expiry and auto-refreshes if the token is expiring within 7 days.
 * @param {string} brandId - Brand ID in Supabase
 * @returns {Promise<string>} A valid Instagram user token
 */
async function getValidPageToken(brandId) {
  const { data: brand, error: fetchError } = await supabase
    .from('brands')
    .select('page_access_token, long_lived_user_token, token_expires_at')
    .eq('id', brandId)
    .single();

  if (fetchError || !brand) {
    throw new Error(`Brand ${brandId} not found: ${fetchError?.message || 'not found'}`);
  }

  // Use whichever token is available (they are the same in the new flow).
  // Read boundary: decrypt here so callers always get a usable token.
  const currentToken = decryptSecret(brand.page_access_token || brand.long_lived_user_token);
  if (!currentToken) {
    throw new Error(`Brand ${brandId} has no Instagram token. Run the OAuth flow first.`);
  }

  // Check if the token is expiring within 7 days
  if (brand.token_expires_at) {
    const expiresAt = new Date(brand.token_expires_at);
    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    if (expiresAt <= sevenDaysFromNow) {
      console.log(`⚠️  [${brandId}] Instagram token expiring soon (${expiresAt.toISOString()}), refreshing...`);
      try {
        const freshToken = await refreshPageToken(brandId);
        return freshToken;
      } catch (refreshError) {
        console.error(`❌ [${brandId}] Token refresh failed: ${refreshError.message}`);
        // Fall back to existing token — it may still work
        console.log(`⚠️  [${brandId}] Falling back to existing token`);
        return currentToken;
      }
    }
  }

  return currentToken;
}

/**
 * Get all brands whose Instagram user tokens are expiring within a given number of days.
 * @param {number} daysUntilExpiry - Number of days threshold
 * @returns {Promise<Array<{id: string, token_expires_at: string}>>}
 */
async function getBrandsWithExpiringTokens(daysUntilExpiry = 7) {
  const threshold = new Date(Date.now() + daysUntilExpiry * 24 * 60 * 60 * 1000).toISOString();

  const { data: brands, error } = await supabase
    .from('brands')
    .select('id, token_expires_at')
    .not('long_lived_user_token', 'is', null)
    .lt('token_expires_at', threshold);

  if (error) {
    throw new Error(`Failed to query expiring tokens: ${error.message}`);
  }

  return brands || [];
}

module.exports = {
  refreshLongLivedToken,
  refreshPageToken,
  getValidPageToken,
  getBrandsWithExpiringTokens,
  syncTokenToIntegrations
};
