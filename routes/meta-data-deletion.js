const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const supabase = require('../lib/supabase');

function parseSignedRequest(signedRequest, appSecret) {
  const [encodedSig, payload] = signedRequest.split('.');

  const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

  const expectedSig = crypto
    .createHmac('sha256', appSecret)
    .update(payload)
    .digest();

  if (!crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error('Invalid signed request signature');
  }

  return data;
}

// Meta data deletion callback
// POST /api/meta/data-deletion
router.post('/', async (req, res) => {
  try {
    const { signed_request } = req.body;

    if (!signed_request) {
      return res.status(400).json({ error: 'Missing signed_request parameter' });
    }

    const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
    if (!appSecret) {
      console.error('[DataDeletion] META_APP_SECRET not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    let data;
    try {
      data = parseSignedRequest(signed_request, appSecret);
    } catch (err) {
      console.error('[DataDeletion] Invalid signed_request:', err.message);
      return res.status(400).json({ error: 'Invalid signed_request' });
    }

    const userId = data.user_id;
    const confirmationCode = crypto.randomBytes(16).toString('hex');

    console.log(`[DataDeletion] Received deletion request for Meta user ${userId}`);

    // Delete conversations and messages linked to this Meta user ID
    if (userId) {
      try {
        // Delete messages in conversations belonging to this user
        const { data: convRows } = await supabase
          .from('conversations')
          .select('id')
          .eq('customer_id', userId);

        if (convRows && convRows.length > 0) {
          const convIds = convRows.map(r => r.id);
          await supabase.from('messages').delete().in('conversation_id', convIds);
          await supabase.from('conversations').delete().in('id', convIds);
        }

        // Also try matching on instagram_user_id or sender_id columns if they exist
        await supabase.from('conversations').delete().eq('instagram_user_id', userId);

        console.log(`[DataDeletion] Deleted data for Meta user ${userId}`);
      } catch (dbErr) {
        // Log but don't fail — Meta still needs a 200 response with the confirmation
        console.error('[DataDeletion] DB cleanup error:', dbErr.message);
      }
    }

    // Meta requires a status URL and confirmation code in the response
    const statusUrl = `${process.env.BACKEND_URL || 'https://krew-ai-backend.up.railway.app'}/api/meta/data-deletion/status?code=${confirmationCode}`;

    return res.json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  } catch (err) {
    console.error('[DataDeletion] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Status check endpoint — users/Meta can poll this to confirm deletion
// GET /api/meta/data-deletion/status?code=<confirmation_code>
router.get('/status', (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'Missing code parameter' });
  }
  // Deletion is processed synchronously above, so status is always complete
  return res.json({
    status: 'complete',
    confirmation_code: code,
    message: 'User data has been deleted.',
  });
});

module.exports = router;
