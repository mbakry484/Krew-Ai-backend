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

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Meta API error:', data);
      throw new Error(`Failed to send DM: ${data.error?.message || 'Unknown error'}`);
    }

    return data;
  } catch (error) {
    console.error('Error sending Instagram DM:', error);
    throw error;
  }
}

module.exports = { sendDM };
