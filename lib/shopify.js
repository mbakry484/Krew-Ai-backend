/**
 * Shopify API integration for creating orders (GraphQL Admin API)
 * Supports expiring offline access tokens with automatic refresh.
 */

const supabase = require('./supabase');

const SHOPIFY_API_VERSION = '2026-04';

// Per-shop mutex to prevent concurrent token refreshes.
// Shopify refresh tokens are single-use — if two requests try to refresh
// with the same token simultaneously, the second one gets a 401.
const refreshInFlight = new Map(); // shopDomain → Promise<accessToken>

/**
 * Thrown when a shop's refresh token has itself expired, so no automatic
 * refresh can succeed. Callers should surface this as a "reconnect the store"
 * state to the merchant rather than retrying. Distinguishable via `.code`.
 */
class ShopifyReconnectRequiredError extends Error {
  constructor(shopDomain) {
    super(`Shopify reconnect required for ${shopDomain}: refresh token has expired`);
    this.name = 'ShopifyReconnectRequiredError';
    this.code = 'SHOPIFY_RECONNECT_REQUIRED';
    this.shopDomain = shopDomain;
  }
}

/**
 * Refresh an expired Shopify access token using the refresh token.
 * Updates the integrations table with the new tokens.
 */
async function refreshShopifyToken(shopDomain, refreshToken) {
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`❌ Shopify token refresh failed (${response.status}):`, body);
    throw new Error(`Shopify token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  // The refresh token also rotates and carries its own (longer) expiry. Persist
  // it so getValidAccessToken can detect a dead refresh token before trying.
  const refreshExpiresAt = data.refresh_token_expires_in
    ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
    : null;

  // Persist new tokens
  await supabase
    .from('integrations')
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: expiresAt,
      refresh_token_expires_at: refreshExpiresAt,
    })
    .eq('shopify_shop_domain', shopDomain)
    .eq('platform', 'shopify');

  console.log(`🔄 Shopify token refreshed for ${shopDomain}`);
  return data.access_token;
}

/**
 * Get a valid Shopify access token for a shop, refreshing if expired.
 * Pass the integration row from Supabase.
 * Uses a per-shop mutex so concurrent requests share one refresh call
 * instead of racing with the same single-use refresh token.
 */
async function getValidAccessToken(integration) {
  const {
    shopify_shop_domain,
    access_token,
    refresh_token,
    token_expires_at,
    refresh_token_expires_at,
  } = integration;

  // If we have expiry info and the token hasn't expired yet (with 5 min buffer), use it
  if (token_expires_at) {
    const expiresAt = new Date(token_expires_at);
    const bufferMs = 5 * 60 * 1000; // refresh 5 minutes early
    if (expiresAt.getTime() - bufferMs > Date.now()) {
      return access_token;
    }
  }

  // Token is expired or no expiry info — try to refresh
  if (refresh_token) {
    // If the refresh token itself has expired, no refresh can succeed. Surface a
    // clear "reconnect required" state instead of firing a doomed refresh call.
    if (refresh_token_expires_at && new Date(refresh_token_expires_at).getTime() <= Date.now()) {
      console.error(`🔒 Shopify refresh token expired for ${shopify_shop_domain} — merchant must reconnect the store.`);
      throw new ShopifyReconnectRequiredError(shopify_shop_domain);
    }

    // If another request is already refreshing this shop's token, wait for it
    if (refreshInFlight.has(shopify_shop_domain)) {
      console.log(`⏳ Waiting for in-flight token refresh for ${shopify_shop_domain}`);
      return refreshInFlight.get(shopify_shop_domain);
    }

    // Start the refresh and register the promise so concurrent callers can share it
    const refreshPromise = refreshShopifyToken(shopify_shop_domain, refresh_token)
      .finally(() => {
        refreshInFlight.delete(shopify_shop_domain);
      });

    refreshInFlight.set(shopify_shop_domain, refreshPromise);
    return refreshPromise;
  }

  // No refresh token available — this is a LEGACY non-expiring offline token.
  // It still works, but Shopify now flags its use as deprecated. Keep it working
  // so un-migrated stores don't break, but log loudly (with the shop domain) so
  // we can spot any rows that still need migrateLegacyShopifyTokens() to run.
  console.warn(
    `⚠️ LEGACY Shopify token in use for ${shopify_shop_domain} — non-expiring offline token (refresh_token IS NULL). ` +
    `Run migrateLegacyShopifyTokens() to rotate it to an expiring token.`
  );
  return access_token;
}

/**
 * Helper to execute a Shopify Admin GraphQL query/mutation
 */
async function shopifyGraphQL(shopDomain, accessToken, query, variables = {}) {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`❌ Shopify GraphQL ${response.status} | shop: ${shopDomain}`);
    console.error(`❌ Response body:`, errorBody);
    throw new Error(`Shopify GraphQL HTTP error: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch shop info via GraphQL
 * @param {string} shopDomain
 * @param {string} accessToken
 * @returns {Promise<string|null>} Shop name or null
 */
async function getShopName(shopDomain, accessToken) {
  const query = `query { shop { name } }`;
  const result = await shopifyGraphQL(shopDomain, accessToken, query);
  return result?.data?.shop?.name || null;
}

/**
 * Fetch the brand's published storefront URL via GraphQL.
 * Returns the primary domain (custom domain like https://krew.com if configured,
 * otherwise the https://*.myshopify.com URL). Used to build clickable product links.
 * @param {string} shopDomain
 * @param {string} accessToken
 * @returns {Promise<string|null>} Storefront URL (e.g. "https://krew.com") or null
 */
async function getStorefrontUrl(shopDomain, accessToken) {
  const query = `query { shop { primaryDomain { url } } }`;
  const result = await shopifyGraphQL(shopDomain, accessToken, query);
  return result?.data?.shop?.primaryDomain?.url || null;
}

/**
 * Create a Shopify order via GraphQL Admin API
 * @param {Object} params - Order creation parameters
 * @param {string} params.shopDomain - Shopify shop domain (e.g., 'mystore.myshopify.com')
 * @param {string} params.accessToken - Shopify Admin API access token
 * @param {Object} params.order - Order details
 * @param {string} params.order.variant_id - Shopify variant ID (numeric or GID)
 * @param {string} params.order.product_name - Product name
 * @param {number} params.order.price - Product price
 * @param {string} params.order.customer_name - Customer full name
 * @param {string} params.order.customer_phone - Customer phone number
 * @param {string} params.order.customer_address - Customer delivery address
 * @returns {Promise<Object>} Created Shopify order { id, name } (name = order number like #1001)
 */
async function createShopifyOrder({ shopDomain, accessToken, order }) {
  // Ensure variant ID is in GID format
  const variantGid = order.variant_id.toString().includes('gid://')
    ? order.variant_id
    : `gid://shopify/ProductVariant/${order.variant_id}`;

  const mutation = `
    mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        userErrors {
          field
          message
        }
        order {
          id
          name
        }
      }
    }
  `;

  const variables = {
    order: {
      lineItems: [
        {
          variantId: variantGid,
          quantity: 1,
        },
      ],
      customer: {
        toUpsert: {
          firstName: order.customer_name,
          phone: order.customer_phone,
          email: `${order.customer_phone.replace(/\+/g, '')}@instagram.placeholder`,
        },
      },
      shippingAddress: {
        address1: order.customer_address,
        phone: order.customer_phone,
        firstName: order.customer_name,
      },
      financialStatus: 'PENDING',
      note: 'Order placed via Instagram DM by Luna AI',
    },
    options: {
      inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
      sendReceipt: false,
    },
  };

  const result = await shopifyGraphQL(shopDomain, accessToken, mutation, variables);

  const userErrors = result?.data?.orderCreate?.userErrors;
  if (userErrors && userErrors.length > 0) {
    const errorMsg = userErrors.map(e => `${e.field?.join('.')}: ${e.message}`).join(' | ');
    throw new Error(`Shopify orderCreate error: ${errorMsg}`);
  }

  const createdOrder = result?.data?.orderCreate?.order;
  if (!createdOrder) {
    throw new Error('Shopify orderCreate returned no order');
  }

  console.log(`✅ Shopify order created: ${createdOrder.name || createdOrder.id}`);
  return createdOrder;
}

/**
 * Look up a Shopify order by its order number (e.g. "1005") via the Admin GraphQL API.
 * Returns the order details if found, or null.
 */
async function getShopifyOrderByNumber(shopDomain, accessToken, orderNumber) {
  const cleanNumber = orderNumber.replace(/^#/, '').trim();

  const query = `
    query getOrderByNumber($query: String!) {
      orders(first: 1, query: $query) {
        nodes {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          customer {
            firstName
            lastName
            displayName
          }
          shippingAddress {
            firstName
            lastName
            name
          }
          billingAddress {
            firstName
            lastName
            name
          }
          lineItems(first: 20) {
            nodes {
              title
              quantity
              variant {
                id
              }
            }
          }
        }
      }
    }
  `;

  const result = await shopifyGraphQL(shopDomain, accessToken, query, {
    query: `name:#${cleanNumber}`,
  });

  const order = result?.data?.orders?.nodes?.[0];
  if (!order) return null;

  // Resolve customer name: try customer object → shipping address → billing address
  const resolveCustomerName = () => {
    if (order.customer) {
      const full = `${order.customer.firstName || ''} ${order.customer.lastName || ''}`.trim();
      if (full) return full;
      if (order.customer.displayName) return order.customer.displayName;
    }
    if (order.shippingAddress) {
      const full = `${order.shippingAddress.firstName || ''} ${order.shippingAddress.lastName || ''}`.trim();
      if (full) return full;
      if (order.shippingAddress.name) return order.shippingAddress.name;
    }
    if (order.billingAddress) {
      const full = `${order.billingAddress.firstName || ''} ${order.billingAddress.lastName || ''}`.trim();
      if (full) return full;
      if (order.billingAddress.name) return order.billingAddress.name;
    }
    return null;
  };

  return {
    shopify_id: order.id,
    order_number: order.name,  // e.g. "#1005"
    customer_name: resolveCustomerName(),
    created_at: order.createdAt,
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    line_items: order.lineItems.nodes.map(li => ({
      title: li.title,
      quantity: li.quantity,
      variant_id: li.variant?.id || null,
    })),
  };
}

/**
 * One-time token exchange: rotate a legacy (non-expiring) offline access token
 * into an expiring offline access token + refresh token, per
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
 *
 * The exchange only rotates the token on success (HTTP 200); if it fails, the
 * original token remains valid, so callers can safely leave the row untouched.
 * @param {string} shopDomain e.g. "mystore.myshopify.com"
 * @param {string} subjectToken the stored legacy offline access token
 * @returns {Promise<Object>} { access_token, refresh_token, expires_in, refresh_token_expires_in }
 */
async function exchangeOfflineToken(shopDomain, subjectToken) {
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: 1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`token-exchange HTTP ${response.status}: ${body}`);
  }

  return response.json();
}

/**
 * Migrate legacy non-expiring Shopify offline tokens to expiring ones.
 *
 * Selects `integrations` rows with platform='shopify' AND refresh_token IS NULL,
 * exchanges each stored access token for an expiring offline token + refresh
 * token, verifies the new token with one cheap Admin API call, and persists it.
 *
 * Safe to re-run: migrated rows gain a refresh_token and are no longer selected.
 * A failure on one shop is logged and the batch continues; because the exchange
 * only rotates on success, a failed shop keeps its original working token.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] when true, only lists affected shops — no exchange, no writes.
 * @returns {Promise<Object>} summary { total, migrated, skipped, failed, shops: [...] }
 */
async function migrateLegacyShopifyTokens({ dryRun = false } = {}) {
  const summary = { total: 0, migrated: 0, skipped: 0, failed: 0, shops: [] };

  const { data: rows, error } = await supabase
    .from('integrations')
    .select('id, shopify_shop_domain, access_token, refresh_token')
    .eq('platform', 'shopify')
    .is('refresh_token', null);

  if (error) {
    throw new Error(`Failed to load legacy integrations: ${error.message}`);
  }

  summary.total = rows?.length || 0;
  console.log(`\n🔎 Found ${summary.total} legacy Shopify integration(s) with refresh_token IS NULL.`);

  for (const row of rows || []) {
    const shop = row.shopify_shop_domain;

    if (!row.access_token) {
      console.warn(`⏭️  ${shop}: no stored access_token — skipping (needs full reconnect).`);
      summary.skipped++;
      summary.shops.push({ shop, status: 'skipped_no_token' });
      continue;
    }

    if (dryRun) {
      console.log(`   • [dry-run] would migrate ${shop}`);
      summary.shops.push({ shop, status: 'dry_run' });
      continue;
    }

    try {
      const data = await exchangeOfflineToken(shop, row.access_token);

      if (!data.access_token) {
        throw new Error('exchange returned no access_token');
      }
      if (!data.refresh_token) {
        // Exchange succeeded but Shopify returned a non-expiring token again.
        // Leave the row as-is (still refresh_token NULL) rather than persisting
        // a token we can't rotate; it will be picked up on a future run.
        console.warn(`⚠️ ${shop}: exchange returned NO refresh_token — leaving legacy token in place.`);
        summary.skipped++;
        summary.shops.push({ shop, status: 'no_refresh_token_returned' });
        continue;
      }

      // Verify the new token with one cheap Admin API call before trusting it.
      const shopName = await getShopName(shop, data.access_token);

      const token_expires_at = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null;
      const refresh_token_expires_at = data.refresh_token_expires_in
        ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
        : null;

      const { error: updateError } = await supabase
        .from('integrations')
        .update({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          token_expires_at,
          refresh_token_expires_at,
        })
        .eq('id', row.id);

      if (updateError) {
        throw new Error(`DB update failed: ${updateError.message}`);
      }

      console.log(`✅ ${shop}: migrated (verified as "${shopName || 'unknown'}").`);
      summary.migrated++;
      summary.shops.push({ shop, status: 'migrated' });
    } catch (err) {
      // Exchange/verify failed — the original token is untouched and still valid.
      console.error(`❌ ${shop}: migration failed — ${err.message}`);
      summary.failed++;
      summary.shops.push({ shop, status: 'failed', error: err.message });
    }
  }

  console.log(
    `\n📊 Migration ${dryRun ? '(dry-run) ' : ''}summary: ` +
    `${summary.total} total, ${summary.migrated} migrated, ${summary.skipped} skipped, ${summary.failed} failed.`
  );
  return summary;
}

module.exports = { createShopifyOrder, getShopName, getStorefrontUrl, getShopifyOrderByNumber, shopifyGraphQL, getValidAccessToken, refreshShopifyToken, exchangeOfflineToken, migrateLegacyShopifyTokens, ShopifyReconnectRequiredError, SHOPIFY_API_VERSION };
