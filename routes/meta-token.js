const express = require('express');
const router = express.Router();
const { refreshPageToken } = require('../src/services/metaTokenService');

/**
 * POST /api/meta/refresh-token
 * Manually trigger a token refresh for a brand's Instagram user token.
 *
 * Body: { brand_id: string }
 */
router.post('/refresh-token', async (req, res) => {
  try {
    const { brand_id } = req.body;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    console.log(`🔑 Manual token refresh requested for brand: ${brand_id}`);

    const freshToken = await refreshPageToken(brand_id);

    // Mask the token for the response (security)
    const maskedToken = freshToken.substring(0, 12) + '...' + freshToken.substring(freshToken.length - 6);

    res.json({
      success: true,
      message: 'Instagram token refreshed successfully',
      token_preview: maskedToken
    });

  } catch (error) {
    console.error('❌ Token refresh failed:', error.message);
    res.status(500).json({
      error: 'Token refresh failed',
      details: error.message
    });
  }
});

module.exports = router;
