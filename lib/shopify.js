/**
 * Shopify API integration for creating orders (GraphQL Admin API)
 */

const SHOPIFY_API_VERSION = '2026-04';

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

module.exports = { createShopifyOrder, getShopName, shopifyGraphQL, SHOPIFY_API_VERSION };
