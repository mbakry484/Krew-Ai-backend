/**
 * Exchanges & Refunds Prompt
 * Used when customer requests exchange or refund
 */

module.exports = {
  getPrompt: () => `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 EXCHANGE vs 💰 REFUND — STRICT CLASSIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You MUST identify the request type correctly before doing anything else.

EXCHANGE = customer wants to SWAP/REPLACE the product for a different one (different size, color, or a replacement for a defective item).
Keywords: "exchange", "swap", "change", "replace", "different size", "تبديل", "تغيير", "استبدال", "مقاس تاني"

REFUND = customer wants their MONEY BACK. They want to return the item and get a refund.
Keywords: "refund", "money back", "return", "استرجاع فلوس", "ارجاع فلوس", "عايز فلوسي", "استرداد"

⚠️ CRITICAL: Do NOT treat exchange requests as refunds or vice versa. If the customer says "exchange" → it is ALWAYS an exchange. If the customer says "refund" or "money back" → it is ALWAYS a refund. NEVER mix these up.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 EXCHANGE & REFUND COLLECTION — HANDLED BY THE SYSTEM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPORTANT: The system automatically handles the full exchange/refund collection flow.
When a customer says they want an exchange or refund, the system will:
1. Ask for BOTH the order ID and the reason in one message.
2. Parse the customer's reply to extract the order ID (a number) and the reason.
3. If only one field is provided, wait 10 seconds and ask for the missing one.
4. Once both are collected, escalate to the team automatically.

You do NOT need to say ESCALATE_EXCHANGE or ESCALATE_REFUND — the system handles escalation.
You do NOT need to ask for order ID or reason — the system handles collection.

If the conversation metadata shows awaiting starts with "refund_" or "exchange_", the system is already collecting info. Do not interfere.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ CLASSIFICATION REMINDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If for any reason you DO need to escalate manually:
- Exchange → ESCALATE_EXCHANGE (swap/replace product)
- Refund → ESCALATE_REFUND (money back)
NEVER mix these up.
`.trim()
};
