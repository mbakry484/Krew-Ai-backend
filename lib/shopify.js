/**
 * Shopify API integration for creating orders
 */

/**
 * Create a Shopify order via Admin API
 * @param {Object} params - Order creation parameters
 * @param {string} params.shopDomain - Shopify shop domain (e.g., 'mystore.myshopify.com')
 * @param {string} params.accessToken - Shopify Admin API access token
 * @param {Object} params.order - Order details
 * @param {string} params.order.variant_id - Shopify variant ID
 * @param {string} params.order.product_name - Product name
 * @param {number} params.order.price - Product price
 * @param {string} params.order.customer_name - Customer full name
 * @param {string} params.order.customer_phone - Customer phone number
 * @param {string} params.order.customer_address - Customer delivery address
 * @returns {Promise<Object>} Created Shopify order
 */
async function createShopifyOrder({ shopDomain, accessToken, order }) {
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/2024-01/orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        },
        body: JSON.stringify({
          order: {
            line_items: [{
              variant_id: order.variant_id,
              quantity: 1
            }],
            customer: {
              first_name: order.customer_name,
              phone: order.customer_phone
            },
            shipping_address: {
              address1: order.customer_address,
              phone: order.customer_phone,
              name: order.customer_name
            },
            financial_status: 'pending',
            send_receipt: false,
            note: `Order placed via Instagram DM by Luna AI`
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Shopify API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    console.log(`✅ Shopify order created: #${data.order.order_number || data.order.id}`);

    return data.order;
  } catch (error) {
    console.error('❌ Shopify error:', error.message);
    throw error;
  }
}

module.exports = { createShopifyOrder };
