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
  const { error: updateError } = await supabase
    .from('integrations')
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: expiresAt,
    })
    .eq('shopify_shop_domain', shopDomain)
    .eq('platform', 'shopify');

  if (updateError) {
    throw new Error(`Shopify token refresh succeeded but failed to save: ${updateError.message}`);
  }

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

module.exports = { createShopifyOrder, getShopName, getShopifyOrderByNumber, shopifyGraphQL, getValidAccessToken, refreshShopifyToken, SHOPIFY_API_VERSION };
