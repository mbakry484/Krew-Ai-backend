/**
 * Product Catalog Prompt
 * Dynamic prompt for product availability and recommendations
 */

/**
 * Build the public storefront URL for a product.
 * Prefers Shopify's prebuilt onlineStoreUrl, else {storefrontUrl}/products/{handle}.
 * Returns null when there's no usable handle/domain.
 */
function buildProductUrl(product, storefrontUrl) {
  if (product.online_store_url) return product.online_store_url;
  if (storefrontUrl && product.handle) {
    return `${storefrontUrl.replace(/\/$/, '')}/products/${product.handle}`;
  }
  return null;
}

module.exports = {
  buildProductUrl,

  getPrompt: (inStockProducts = [], outOfStockProducts = [], storefrontUrl = null) => {
    const hasWebsite = !!storefrontUrl;

    let prompt = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛒 PRODUCT CATALOG — STRICT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⛔ ABSOLUTE PRODUCT RULES — NEVER VIOLATE:
- You can ONLY recommend, discuss, or sell products listed below. No exceptions.
- NEVER invent, fabricate, or hallucinate products, prices, sizes, colors, or availability.
- NEVER say a product is available if it's listed as OUT OF STOCK below.
- NEVER say a product exists if it's not in the catalog below.
- NEVER guess prices — use ONLY the exact prices listed.
`;

    // Website-first behaviour — how to answer product questions when we have a storefront
    if (hasWebsite) {
      prompt += `
🌐 WEBSITE-FIRST — HOW TO ANSWER PRODUCT QUESTIONS:
- GENERAL browsing questions ("what do you have?", "what are you selling?", "show me your products", "what's available?", "what's new?") → DO NOT list any products. We carry a wide range and listing them in DMs is overwhelming. Instead, tell the customer there's a wide variety to explore and share the website link so they can browse everything themselves.
  Example: "We've got a wide range of pieces you can explore here: ${storefrontUrl} 😊 Anything specific you're looking for?"
- SPECIFIC product questions ("do you have the [X]?", "how much is the [Y]?", "is [Z] available?") → look it up in the catalog below. If it's IN STOCK, share its details (name, price, key info) AND its product link so they can order it on the website. If it's OUT OF STOCK, say so honestly and point them to the website to browse similar pieces.
- ⛔ NEVER dump the catalog or a long numbered list into DMs. Always steer general browsing to the website link.
`;
    } else {
      prompt += `
- When a customer asks generally "what do you have?" → give a short, high-level answer about the kinds of products available and ask what they're looking for. Do NOT dump the full catalog or a long list.
- When a customer asks about a SPECIFIC product → look it up below and share its details (name, price, availability) if it's IN STOCK.
`;
    }

    prompt += `- If a customer asks about a product not in the catalog → say: "I don't see that one in our current collection."${hasWebsite ? ' and point them to the website to browse what\'s available.' : ' and suggest the closest alternative.'}
- Reference products by their number when discussing multiple options (e.g., "Would you like number 1 or number 2?").
- NEVER recommend more than 5 products at once — if there are many${hasWebsite ? ', direct them to the website to browse' : ', ask what category/type they\'re looking for first'}.
`;

    // Link-sharing rules — only when we actually have a storefront URL to share
    if (storefrontUrl) {
      prompt += `
🔗 SHARING LINKS — STRICT RULES:
- The brand's website is: ${storefrontUrl}
- When a customer asks to browse, see "everything", or generally what you sell, share the website link (${storefrontUrl}) instead of listing or dumping the catalog.
- When you discuss a SPECIFIC in-stock product that has a "link:" listed below, share that exact link and encourage them to complete the order on the website.
- ⛔ ONLY share links that appear in this catalog (the website link above or a product's "link:"). NEVER invent, guess, or modify a URL.
- If a product has no "link:" listed, just give its name and price — do not fabricate a link for it.
- Send the raw URL as-is (e.g. ${storefrontUrl}). Do not wrap it in markdown or shorten it.
`;
    }

    // Build in-stock product list with variant details
    const inStockList = (inStockProducts || []).slice(0, 30).map((p, i) => {
      let line = `${i + 1}. ${p.name} - ${p.price} EGP ✅ In Stock`;
      const productUrl = buildProductUrl(p, storefrontUrl);
      if (productUrl) {
        line += `\n     ↳ link: ${productUrl}`;
      }
      const variants = p.variants || [];
      if (variants.length > 0) {
        const variantLines = variants
          .filter(v => (v.inventoryQuantity ?? v.inventory_quantity ?? 0) > 0)
          .map(v => {
            const vid = v.id || '';
            const label = v.title && v.title !== 'Default Title' ? v.title : 'Default';
            const vPrice = v.price ? ` - ${v.price} EGP` : '';
            return `     ↳ variant_id: "${vid}" | ${label}${vPrice}`;
          });
        if (variantLines.length > 0) {
          line += '\n' + variantLines.join('\n');
        }
      }
      return line;
    }).join('\n');

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
AVAILABILITY RULES — STRICT:
- You can ONLY take orders for IN STOCK (✅) products. Never accept an order for an OOS product.
- If customer asks about an OOS product → acknowledge it exists, clearly state it's currently unavailable, then suggest the closest IN STOCK alternatives.
- ⛔ NEVER pretend an OOS product is available or say "let me check" — you already have the full catalog above.
- ⛔ NEVER promise restock dates or timelines. If asked → say: "I don't have a restock date yet, but we'll announce it when it's back!"
- ⛔ NEVER take a "pre-order" or "waitlist" request unless the brand explicitly supports it.
- If ALL products are out of stock → be honest: "We're currently restocking — I'll let the team know you're interested and we'll reach out when new items are available!"
`;

    return prompt.trim();
  },

  getImageHandlingPrompt: () => `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📸 IMAGE HANDLING — STRICT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a customer sends an image, follow this exact process:

STEP 1: Identify what the image shows (product type, style, color, category).
STEP 2: Search the Product Catalog above for a matching or similar IN STOCK product.
STEP 3: Respond based on what you find:

   MATCH FOUND (in stock):
   → Confirm the product name, price, and availability — state it as fact, never hedge with "seems like" / "looks like" / "I think".
   → Example: "That's our [Product Name]! It's [Price] EGP and available. Want to order it?"

   SIMILAR PRODUCT FOUND (not exact match):
   → Acknowledge what they sent, suggest the closest alternative.
   → Example: "I see what you're looking for! The closest we have is [Product Name] for [Price] EGP — want to take a look?"

   NO MATCH FOUND:
   → Be honest that you don't carry that exact item, suggest browsing what's available.
   → Example: "I don't think we have that exact one, but here's what we have in a similar style!"

⛔ NEVER identify a product in the image as one of your catalog items unless it genuinely matches.
⛔ NEVER make up a product name or price based on what you see in the image.
⛔ NEVER say "we have this!" if the catalog doesn't actually contain it.
⛔ If the image is unclear or not a product → ask: "Could you tell me what you're looking for? I'd love to help!"
`.trim()
};
