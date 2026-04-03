const express = require('express');
const router = express.Router();
const { exchangeAndSave } = require('../src/services/metaTokenService');

/**
 * POST /api/meta/exchange-token
 * Exchange a short-lived Meta token for a long-lived page token.
 * 
 * Body: { brand_id: string, short_lived_token: string }
 * 
 * Flow:
 *   1. Short-lived token → Long-lived user token (60 days)
 *   2. Long-lived user token → Page access token (never expires)
 *   3. Save both tokens + expiry to brands table
 *   4. Sync page token to integrations table
 */
router.post('/exchange-token', async (req, res) => {
  try {
    const { brand_id, short_lived_token } = req.body;

    // Validate inputs
    if (!brand_id || !short_lived_token) {
      return res.status(400).json({
        error: 'brand_id and short_lived_token are required'
      });
    }

    console.log(`🔑 Token exchange requested for brand: ${brand_id}`);

    // Run the full exchange flow
    const { pageToken, expiresAt } = await exchangeAndSave(brand_id, short_lived_token);

    // Mask the token for the response (security)
    const maskedToken = pageToken.substring(0, 12) + '...' + pageToken.substring(pageToken.length - 6);

    res.json({
      success: true,
      message: 'Token exchanged and saved successfully',
      token_preview: maskedToken,
      user_token_expires_at: expiresAt,
      note: 'Page access token does not expire. User token backing it expires at the date shown.'
    });

  } catch (error) {
    console.error('❌ Token exchange failed:', error.message);
    res.status(500).json({
      error: 'Token exchange failed',
      details: error.message
    });
  }
});

module.exports = router;
