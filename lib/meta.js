/**
 * Instagram DMs render plain text only — markdown links come out as literal
 * "[label](url)" and the customer sees broken brackets. The AI is instructed
 * to send raw URLs, but models occasionally slip, so strip any markdown link
 * down to its bare URL right before sending. Handles "[link] (url)" with a
 * space too.
 */
function stripMarkdownLinks(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\[([^\]]*)\]\s*\((https?:\/\/[^)\s]+)\)/g, '$2');
}

/**
 * Send a direct message via Instagram Graph API.
 * Uses the Instagram Business Login token (not a Page Access Token).
 * @param {string} recipientId - Instagram Scoped ID (IGSID) of the recipient
 * @param {string} message - The message text to send
 * @param {string} accessToken - Instagram user access token
 * @returns {Promise<object>} Response from Meta API
 */
async function sendDM(recipientId, message, accessToken) {
  const url = `https://graph.instagram.com/v21.0/me/messages`;
  message = stripMarkdownLinks(message);

  const body = {
    recipient: {
      id: recipientId,
    },
    message: {
      text: message,
    },
  };

  console.log(`   🌐 Instagram API → ${recipientId} (${message.length} chars)`);

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

    if (!response.ok) console.log(`   📨 Instagram API ${response.status} (${duration}ms)`);

    if (!response.ok) {
      console.error('   ❌ Instagram API error:', {
        message: data.error?.message,
        type: data.error?.type,
        code: data.error?.code,
        subcode: data.error?.error_subcode
      });
      throw new Error(`Failed to send DM: ${data.error?.message || 'Unknown error'}`);
    }

    console.log(`   ✅ Sent (${duration}ms)`);
    return data;
  } catch (error) {
    console.error('   ❌ Error sending Instagram DM:', error.message);
    throw error;
  }
}

/**
 * Fetch an Instagram user's public profile (name + username) via Graph API.
 * @param {string} igsid - Instagram Scoped ID of the customer
 * @param {string} accessToken - Instagram user access token
 * @returns {Promise<{name: string|null, username: string|null}|null>}
 */
async function getUserProfile(igsid, accessToken) {
  try {
    const url = `https://graph.instagram.com/v21.0/${igsid}?fields=name,username&access_token=${accessToken}`;
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
 * Send an image attachment via Instagram DM.
 * @param {string} recipientId - Instagram Scoped ID (IGSID) of the recipient
 * @param {string} imageUrl - Publicly accessible URL of the image to send
 * @param {string} accessToken - Instagram user access token
 * @returns {Promise<object>} Response from Meta API
 */
async function sendImageDM(recipientId, imageUrl, accessToken) {
  const url = `https://graph.instagram.com/v21.0/me/messages`;

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
      console.error('❌ Instagram API image send error:', data.error?.message);
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
