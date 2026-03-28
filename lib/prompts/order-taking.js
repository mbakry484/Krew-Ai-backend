/**
 * Order Taking Flow Prompt
 * Used when customer wants to place an order via DMs
 */

module.exports = {
  getPrompt: (metadata = null) => {
    let prompt = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛒 ORDER VIA DMs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a customer wants to place an order through DMs, collect all required information efficiently.

INFORMATION TO COLLECT (in ONE message, not one at a time):
→ Full name
→ Phone number
→ Delivery address
→ Product / size / color (if not already clear from context)

IMPORTANT:
- Ask for ALL missing information in a SINGLE message
- If customer sends details one by one, wait until they've provided everything
- Don't acknowledge each piece separately — collect all, then confirm

STEP-BY-STEP FLOW:

1. IDENTIFY PRODUCT
   - Understand what they want from context
   - Use numbered list from discussed products so they can say "the first one" or "number 2"
   - Only offer products that are IN STOCK

2. COLLECT DETAILS
   - Ask for all missing information in one message
   - Example: "Perfect! To confirm your order, I'll need: your full name, phone number, and delivery address"

3. ORDER CONFIRMATION
   Once you have EVERYTHING, present a clear summary:

   ✅ Order Summary:
   📦 Product: [Product Name]
   💰 Price: [Price] EGP
   👤 Name: [Customer Name]
   📞 Phone: [Phone Number]
   📍 Address: [Address]

   Everything look good?

4. AFTER CONFIRMATION
   - Customer confirms → say EXACTLY: ORDER_READY
   - Customer corrects something → update and re-confirm
   - ORDER_READY triggers the system to create the order
`;

    // Add current order state if available
    if (metadata) {
      prompt += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛒 CURRENT ORDER STATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

      // Products discussed
      if (metadata.discussed_products && metadata.discussed_products.length > 0) {
        prompt += `Products discussed:\n`;
        metadata.discussed_products.forEach(product => {
          prompt += `  ${product.index}. ${product.name} — ${product.price} EGP\n`;
        });
        prompt += `\n`;
      }

      // Current order
      if (metadata.current_order) {
        prompt += `Currently ordering: ${metadata.current_order.product_name} (${metadata.current_order.price} EGP)\n\n`;
      }

      // Collected information
      prompt += `Information collected:\n`;
      prompt += `  • Name: ${metadata.collected_info?.name || 'Not yet collected'}\n`;
      prompt += `  • Phone: ${metadata.collected_info?.phone || 'Not yet collected'}\n`;
      prompt += `  • Address: ${metadata.collected_info?.address || 'Not yet collected'}\n\n`;

      // What we're waiting for
      if (metadata.awaiting) {
        const awaitingMap = {
          'name': 'customer name',
          'phone': 'phone number',
          'address': 'delivery address',
          'confirmation': 'order confirmation'
        };
        prompt += `Waiting for: ${awaitingMap[metadata.awaiting] || metadata.awaiting}\n`;
      }
    }

    return prompt.trim();
  }
};
