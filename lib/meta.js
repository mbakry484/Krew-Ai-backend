/**
 * Send a direct message via Instagram Graph API
 * @param {string} recipientId - Instagram Scoped ID (IGSID) of the recipient
 * @param {string} message - The message text to send
 * @param {string} accessToken - Page access token for the Instagram account
 * @returns {Promise<object>} Response from Meta API
 */
async function sendDM(recipientId, message, accessToken) {
  const url = `https://graph.facebook.com/v21.0/me/messages`;

  const body = {
    recipient: {
      id: recipientId,
    },
    message: {
      text: message,
    },
  };

  console.log(`   🌐 Meta API Request:`);
  console.log(`      URL: ${url}`);
  console.log(`      Recipient: ${recipientId}`);
  console.log(`      Message length: ${message.length} chars`);
  console.log(`      Token: ${accessToken.substring(0, 15)}...`);

  try {
    const startTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    const duration = Date.now() - startTime;

    console.log(`   📨 Meta API Response (${duration}ms):`, {
      status: response.status,
      ok: response.ok,
      hasMessageId: !!data.message_id,
      hasError: !!data.error
    });

    if (!response.ok) {
      console.error('   ❌ Meta API error:', {
        message: data.error?.message,
        type: data.error?.type,
        code: data.error?.code,
        subcode: data.error?.error_subcode
      });
      throw new Error(`Failed to send DM: ${data.error?.message || 'Unknown error'}`);
    }

    console.log(`   ✅ Message sent! ID: ${data.message_id}`);
    return data;
  } catch (error) {
    console.error('   ❌ Error sending Instagram DM:', error.message);
    throw error;
  }
}

module.exports = { sendDM };
