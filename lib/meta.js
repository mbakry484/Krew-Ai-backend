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

/**
 * Fetch an Instagram user's public profile (name + username) via Graph API.
 * Uses the /{igsid}?fields=name,username endpoint available for IGSIDs.
 * Returns null on any failure so the caller can fall back gracefully.
 *
 * @param {string} igsid - Instagram Scoped ID of the customer
 * @param {string} accessToken - Page access token
 * @returns {Promise<{name: string|null, username: string|null}|null>}
 */
async function getUserProfile(igsid, accessToken) {
  try {
    const url = `https://graph.facebook.com/v21.0/${igsid}?fields=name,username&access_token=${accessToken}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.error) {
      console.warn(`⚠️  Could not fetch profile for ${igsid}:`, data.error?.message || 'unknown error');
      return null;
    }

    return {
      name: data.name || null,
      username: data.username || null,
    };
  } catch (err) {
    console.warn(`⚠️  getUserProfile failed for ${igsid}:`, err.message);
    return null;
  }
}

/**
 * Send an image attachment via Instagram DM using the attachment URL payload.
 * @param {string} recipientId - Instagram Scoped ID (IGSID) of the recipient
 * @param {string} imageUrl - Publicly accessible URL of the image to send
 * @param {string} accessToken - Page access token
 * @returns {Promise<object>} Response from Meta API
 */
async function sendImageDM(recipientId, imageUrl, accessToken) {
  const url = `https://graph.facebook.com/v21.0/me/messages`;

  const body = {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'image',
        payload: {
          url: imageUrl,
          is_reusable: true
        }
      }
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Meta API image send error:', data.error?.message);
      throw new Error(`Failed to send image DM: ${data.error?.message || 'Unknown error'}`);
    }

    console.log(`✅ Image sent to ${recipientId}`);
    return data;
  } catch (error) {
    console.error('❌ Error sending image DM:', error.message);
    throw error;
  }
}

module.exports = { sendDM, sendImageDM, getUserProfile };
