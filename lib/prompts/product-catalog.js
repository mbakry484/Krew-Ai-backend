/**
 * Product Catalog Prompt
 * Dynamic prompt for product availability and recommendations
 */

module.exports = {
  getPrompt: (inStockProducts = [], outOfStockProducts = []) => {
    let prompt = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛒 PRODUCT CATALOG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRODUCT RULES:
- Only recommend or sell products listed below
- If product is out of stock → let customer know politely and suggest alternatives
- Never make up products, prices, or availability
- Reference products by number when discussed (e.g., "Would you like the first one?")
- When customer asks "what do you have?" → only list IN STOCK products
`;

    // Build in-stock product list
    const inStockList = (inStockProducts || []).slice(0, 30).map((p, i) =>
      `${i + 1}. ${p.name} - ${p.price} EGP ✅ In Stock`
    ).join('\n');

    // Build out-of-stock product list
    const outOfStockList = (outOfStockProducts || []).slice(0, 30).map((p, i) =>
      `${i + 1}. ${p.name} - ${p.price} EGP ❌ Out of Stock`
    ).join('\n');

    // Add available products section
    prompt += `\nAVAILABLE PRODUCTS (can be ordered):\n`;
    if (inStockList) {
      prompt += `${inStockList}\n`;
    } else {
      prompt += `No products currently in stock\n`;
    }

    // Add out-of-stock products section
    prompt += `\nOUT OF STOCK PRODUCTS (cannot be ordered):\n`;
    if (outOfStockList) {
      prompt += `${outOfStockList}\n`;
    } else {
      prompt += `None\n`;
    }

    // Add availability rules
    prompt += `
AVAILABILITY RULES:
- Only offer to take orders for IN STOCK products
- If asked about OOS product → acknowledge it exists, state it's unavailable, suggest alternatives
- Never pretend an OOS product is available
- If customer asks about restock dates → be honest: "Not sure on exact timing yet, but we'll announce when it's back!"
`;

    return prompt.trim();
  },

  getImageHandlingPrompt: () => `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📸 IMAGE HANDLING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If customer sends an image:
- Identify what product or type of product is shown
- Check if similar product exists in Product Catalog
- If found → confirm availability and price
- If not found → apologize and suggest closest available alternative
- Never make up products that aren't in the catalog

Example: "That looks like [product type]! We have something similar: [product name] for [price] EGP. Want to check it out?"
`.trim()
};
