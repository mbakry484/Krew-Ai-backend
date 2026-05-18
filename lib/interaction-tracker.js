const supabase = require('./supabase');

// 30 minutes in milliseconds — if the gap between messages exceeds this,
// a new interaction is created. Tunable per business needs.
const INTERACTION_GAP_MS = 1 * 60 * 1000;

/**
 * Track an incoming message as part of an interaction.
 *
 * Logic:
 * 1. Find the most recent open interaction for this conversation.
 * 2. If one exists AND the gap since last message is <= 30 min, update it.
 * 3. Otherwise, create a new interaction.
 *
 * This is fire-and-forget by design — it should never block the message flow.
 *
 * @param {object} params
 * @param {string} params.brandId
 * @param {string} params.conversationId
 * @param {string} params.customerId
 * @param {string} [params.customerUsername]
 * @param {string} params.messageId       - UUID of the just-saved message
 * @param {boolean} [params.isEscalated]   - whether the conversation is currently escalated
 */
async function trackInteraction({
  brandId,
  conversationId,
  customerId,
  customerUsername,
  messageId,
  isEscalated = false,
}) {
  try {
    // Find the latest interaction for this conversation
    const { data: latest, error: fetchErr } = await supabase
      .from('interactions')
      .select('id, ended_at, message_count, first_message_id')
      .eq('conversation_id', conversationId)
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr) {
      console.error('interaction-tracker fetch error:', fetchErr.message);
      return;
    }

    const now = new Date();

    if (latest) {
      const gap = now.getTime() - new Date(latest.ended_at).getTime();

      if (gap <= INTERACTION_GAP_MS) {
        // Same interaction — update it
        const { error: updateErr } = await supabase
          .from('interactions')
          .update({
            ended_at: now.toISOString(),
            message_count: latest.message_count + 1,
            last_message_id: messageId,
            was_escalated: isEscalated || undefined,
          })
          .eq('id', latest.id);

        if (updateErr) {
          console.error('interaction-tracker update error:', updateErr.message);
        }
        return;
      }
    }

    // New interaction
    const { error: insertErr } = await supabase
      .from('interactions')
      .insert({
        brand_id: brandId,
        conversation_id: conversationId,
        customer_id: customerId,
        customer_username: customerUsername || null,
        started_at: now.toISOString(),
        ended_at: now.toISOString(),
        message_count: 1,
        first_message_id: messageId,
        last_message_id: messageId,
        was_escalated: isEscalated,
      });

    if (insertErr) {
      console.error('interaction-tracker insert error:', insertErr.message);
    }
  } catch (err) {
    // Never throw — this must not break the message flow
    console.error('interaction-tracker error:', err.message);
  }
}

module.exports = { trackInteraction, INTERACTION_GAP_MS };
