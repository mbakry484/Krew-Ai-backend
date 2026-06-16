/**
 * Shopify API integration for creating orders (GraphQL Admin API)
 * Supports expiring offline access tokens with automatic refresh.
 */

const supabase = require('./supabase');

const SHOPIFY_API_VERSION = '2026-04';

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

  // Persist new tokens
  await supabase
    .from('integrations')
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: expiresAt,
    })
    .eq('shopify_shop_domain', shopDomain)
    .eq('platform', 'shopify');

  console.log(`🔄 Shopify token refreshed for ${shopDomain}`);
  return data.access_token;
}

/**
 * Get a valid Shopify access token for a shop, refreshing if expired.
 * Pass the integration row from Supabase.
 */
async function getValidAccessToken(integration) {
  const { shopify_shop_domain, access_token, refresh_token, token_expires_at } = integration;

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
    return refreshShopifyToken(shopify_shop_domain, refresh_token);
  }

  // No refresh token available (legacy non-expiring token) — return as-is
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

module.exports = { createShopifyOrder, getShopName, shopifyGraphQL, getValidAccessToken, refreshShopifyToken, SHOPIFY_API_VERSION };
