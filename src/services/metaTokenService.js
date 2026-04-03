const supabase = require('../../lib/supabase');

const META_GRAPH_BASE = 'https://graph.facebook.com/v20.0';

/**
 * Exchange a short-lived user token for a long-lived user token (60-day).
 * @param {string} shortLivedToken - Short-lived token from Meta Graph Explorer
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
async function exchangeForLongLivedToken(shortLivedToken) {
  const url = `${META_GRAPH_BASE}/oauth/access_token`
    + `?grant_type=fb_exchange_token`
    + `&client_id=${process.env.META_APP_ID}`
    + `&client_secret=${process.env.META_APP_SECRET}`
    + `&fb_exchange_token=${shortLivedToken}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    const msg = data.error?.message || 'Unknown error';
    throw new Error(`Failed to exchange for long-lived token: ${msg}`);
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in || 5184000 // default 60 days in seconds
  };
}

/**
 * Fetch all pages the user manages and return the list.
 * @param {string} longLivedUserToken - Long-lived user token
 * @returns {Promise<Array<{id: string, name: string, access_token: string}>>}
 */
async function fetchUserPages(longLivedUserToken) {
  const url = `${META_GRAPH_BASE}/me/accounts?access_token=${longLivedUserToken}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    const msg = data.error?.message || 'Unknown error';
    throw new Error(`Failed to fetch user pages: ${msg}`);
  }

  return data.data || [];
}

/**
 * Derive a page access token from a long-lived user token for a specific page.
 * Page tokens derived this way do not expire on their own.
 * @param {string} longLivedUserToken - The 60-day user token
 * @param {string} fbPageId - The Facebook Page ID to find
 * @returns {Promise<string>} The never-expiring page access token
 */
async function derivePageToken(longLivedUserToken, fbPageId) {
  const pages = await fetchUserPages(longLivedUserToken);
  const page = pages.find(p => p.id === fbPageId);

  if (!page) {
    const availableIds = pages.map(p => `${p.name} (${p.id})`).join(', ');
    throw new Error(
      `Page ${fbPageId} not found in user's pages. Available: ${availableIds || 'none'}`
    );
  }

  return page.access_token;
}

/**
 * Full token exchange flow: short-lived → long-lived user → page token.
 * Saves everything to the brands table.
 * @param {string} brandId - Brand ID in Supabase
 * @param {string} shortLivedToken - Short-lived token from Graph Explorer
 * @returns {Promise<{pageToken: string, expiresAt: string}>}
 */
async function exchangeAndSave(brandId, shortLivedToken) {
  // Step 1: Exchange short-lived → long-lived user token
  console.log(`🔑 [${brandId}] Exchanging short-lived token for long-lived user token...`);
  const { access_token: longLivedUserToken, expires_in } = await exchangeForLongLivedToken(shortLivedToken);
  console.log(`✅ [${brandId}] Got long-lived user token (expires in ${Math.round(expires_in / 86400)} days)`);

  // Step 2: Fetch the brand's fb_page_id
  const { data: brand, error: fetchError } = await supabase
    .from('brands')
    .select('fb_page_id')
    .eq('id', brandId)
    .single();

  if (fetchError || !brand) {
    throw new Error(`Brand ${brandId} not found: ${fetchError?.message || 'not found'}`);
  }

  if (!brand.fb_page_id) {
    // If fb_page_id is not set yet, fetch pages and use the first one
    console.log(`⚠️  [${brandId}] No fb_page_id set, fetching available pages...`);
    const pages = await fetchUserPages(longLivedUserToken);

    if (pages.length === 0) {
      throw new Error('No pages found for this user token. Make sure the token has pages_manage_metadata permission.');
    }

    // Use the first page and save its ID
    const firstPage = pages[0];
    console.log(`📄 [${brandId}] Using page: ${firstPage.name} (${firstPage.id})`);

    const pageAccessToken = firstPage.access_token;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    const { error: updateError } = await supabase
      .from('brands')
      .update({
        fb_page_id: firstPage.id,
        page_access_token: pageAccessToken,
        long_lived_user_token: longLivedUserToken,
        token_expires_at: expiresAt
      })
      .eq('id', brandId);

    if (updateError) {
      throw new Error(`Failed to save tokens for brand ${brandId}: ${updateError.message}`);
    }

    // Also update the integrations table so the Instagram webhook uses the new token
    await syncTokenToIntegrations(brandId, pageAccessToken);

    return { pageToken: pageAccessToken, expiresAt };
  }

  // Step 3: Derive page token for the known fb_page_id
  console.log(`📄 [${brandId}] Deriving page token for page ${brand.fb_page_id}...`);
  const pageAccessToken = await derivePageToken(longLivedUserToken, brand.fb_page_id);
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  // Step 4: Save to brands table
  const { error: updateError } = await supabase
    .from('brands')
    .update({
      page_access_token: pageAccessToken,
      long_lived_user_token: longLivedUserToken,
      token_expires_at: expiresAt
    })
    .eq('id', brandId);

  if (updateError) {
    throw new Error(`Failed to save tokens for brand ${brandId}: ${updateError.message}`);
  }

  // Also update the integrations table so the Instagram webhook uses the new token
  await syncTokenToIntegrations(brandId, pageAccessToken);

  console.log(`✅ [${brandId}] Tokens saved. Page token expires at ${expiresAt}`);
  return { pageToken: pageAccessToken, expiresAt };
}

/**
 * Sync the page access token to the integrations table (Instagram row).
 * This ensures the existing webhook flow uses the fresh token.
 * @param {string} brandId
 * @param {string} pageAccessToken
 */
async function syncTokenToIntegrations(brandId, pageAccessToken) {
  const { error } = await supabase
    .from('integrations')
    .update({ access_token: pageAccessToken })
    .eq('brand_id', brandId)
    .eq('platform', 'instagram');

  if (error) {
    console.error(`⚠️  [${brandId}] Failed to sync token to integrations table: ${error.message}`);
  } else {
    console.log(`🔄 [${brandId}] Token synced to integrations table`);
  }
}

/**
 * Refresh the page token for a brand using its stored long-lived user token.
 * This re-derives the page token and updates both brands and integrations tables.
 * @param {string} brandId - Brand ID in Supabase
 * @returns {Promise<string>} The fresh page access token
 */
async function refreshPageToken(brandId) {
  console.log(`🔄 [${brandId}] Refreshing page token...`);

  const { data: brand, error: fetchError } = await supabase
    .from('brands')
    .select('long_lived_user_token, fb_page_id, token_expires_at')
    .eq('id', brandId)
    .single();

  if (fetchError || !brand) {
    throw new Error(`Brand ${brandId} not found: ${fetchError?.message || 'not found'}`);
  }

  if (!brand.long_lived_user_token) {
    throw new Error(`Brand ${brandId} has no long-lived user token. Run the exchange flow first.`);
  }

  if (!brand.fb_page_id) {
    throw new Error(`Brand ${brandId} has no fb_page_id. Run the exchange flow first.`);
  }

  // Derive a fresh page token from the long-lived user token
  const pageAccessToken = await derivePageToken(brand.long_lived_user_token, brand.fb_page_id);

  // Save the refreshed page token
  const { error: updateError } = await supabase
    .from('brands')
    .update({ page_access_token: pageAccessToken })
    .eq('id', brandId);

  if (updateError) {
    throw new Error(`Failed to save refreshed token for brand ${brandId}: ${updateError.message}`);
  }

  // Sync to integrations table
  await syncTokenToIntegrations(brandId, pageAccessToken);

  console.log(`✅ [${brandId}] Page token refreshed successfully`);
  return pageAccessToken;
}

/**
 * Get a valid page access token for a brand.
 * Checks expiry of the backing long-lived user token and auto-refreshes if needed.
 * @param {string} brandId - Brand ID in Supabase
 * @returns {Promise<string>} A valid page access token
 */
async function getValidPageToken(brandId) {
  const { data: brand, error: fetchError } = await supabase
    .from('brands')
    .select('page_access_token, long_lived_user_token, fb_page_id, token_expires_at')
    .eq('id', brandId)
    .single();

  if (fetchError || !brand) {
    throw new Error(`Brand ${brandId} not found: ${fetchError?.message || 'not found'}`);
  }

  // If no page token exists, cannot proceed
  if (!brand.page_access_token) {
    throw new Error(`Brand ${brandId} has no page access token. Run the exchange flow first.`);
  }

  // Check if the long-lived user token is expiring within 7 days
  if (brand.token_expires_at) {
    const expiresAt = new Date(brand.token_expires_at);
    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    if (expiresAt <= sevenDaysFromNow) {
      console.log(`⚠️  [${brandId}] Long-lived user token expiring soon (${expiresAt.toISOString()}), refreshing...`);
      try {
        const freshToken = await refreshPageToken(brandId);
        return freshToken;
      } catch (refreshError) {
        console.error(`❌ [${brandId}] Token refresh failed: ${refreshError.message}`);
        // Fall back to existing token — it may still work
        console.log(`⚠️  [${brandId}] Falling back to existing page token`);
        return brand.page_access_token;
      }
    }
  }

  return brand.page_access_token;
}

/**
 * Get all brands whose long-lived user tokens are expiring within a given number of days.
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
  exchangeForLongLivedToken,
  fetchUserPages,
  derivePageToken,
  exchangeAndSave,
  refreshPageToken,
  getValidPageToken,
  getBrandsWithExpiringTokens,
  syncTokenToIntegrations
};
