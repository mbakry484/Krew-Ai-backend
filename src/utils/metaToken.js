/**
 * Meta Token Utilities
 * Convenience wrappers around the metaTokenService for use throughout the app.
 */

const { getValidPageToken, refreshPageToken } = require('../services/metaTokenService');

module.exports = {
  getValidPageToken,
  refreshPageToken
};
