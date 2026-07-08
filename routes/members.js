const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

// =============================================================================
// TEAM MEMBERS — owner-only management + Telegram deep-link generation
// =============================================================================
// A brand owner adds team members (media buyers) here and generates a single-use
// Telegram deep link per member. The owner forwards that link to the member;
// when the member taps it, routes/telegram.js binds their chat_id to this brand
// and role (see handleStart).
//
// AUTHORIZATION: every route requires a dashboard session (verifyToken) that
// resolves to a brand_id. Media buyers have NO dashboard login in this design —
// they only ever interact via Telegram — so a resolvable dashboard session is
// inherently the brand owner. brand_id and role are always taken server-side;
// never from the request body.
// =============================================================================

const ROLES = ['owner', 'media_buyer'];
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Resolve the authenticated user's brand_id. Mirrors routes/ivy.js so both the
 *  Supabase and legacy-JWT auth paths work. */
async function resolveBrandId(req) {
  if (req.user && req.user.brand_id) return req.user.brand_id;
  const userId = req.user && req.user.user_id;
  if (!userId) return null;
  const { data: user } = await supabase
    .from('users')
    .select('brand_id')
    .eq('id', userId)
    .maybeSingle();
  return user ? user.brand_id : null;
}

// ── POST /members — add a team member ────────────────────────────────────────
router.post('/', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { name, role, phone } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const memberRole = role || 'media_buyer';
    if (!ROLES.includes(memberRole)) return res.status(400).json({ error: 'invalid role' });

    const { data, error } = await supabase
      .from('brand_members')
      .insert({
        brand_id: brandId,
        name: String(name).trim(),
        role: memberRole,
        phone: phone != null && String(phone).trim() ? String(phone).trim() : null,
      })
      .select('*')
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    console.error('[members] create error:', err.message);
    return res.status(500).json({ error: 'Failed to create member' });
  }
});

// ── GET /members — list this brand's members ─────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { data, error } = await supabase
      .from('brand_members')
      .select('*')
      .eq('brand_id', brandId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error('[members] list error:', err.message);
    return res.status(500).json({ error: 'Failed to list members' });
  }
});

// ── DELETE /members/:id — remove a member ────────────────────────────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const { id } = req.params;

    // Confirm the member belongs to this brand before touching anything.
    const { data: member } = await supabase
      .from('brand_members')
      .select('id')
      .eq('id', id)
      .eq('brand_id', brandId)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Member not found' });

    // Unbind any Telegram channels tied to this member so they stop resolving to
    // a member row (the ON DELETE SET NULL FK would do this too, but we null it
    // explicitly and scope by brand to be safe).
    await supabase
      .from('owner_channels')
      .update({ member_id: null })
      .eq('member_id', id)
      .eq('brand_id', brandId);

    const { error } = await supabase
      .from('brand_members')
      .delete()
      .eq('id', id)
      .eq('brand_id', brandId);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[members] delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete member' });
  }
});

// ── POST /members/:id/telegram-link — generate a single-use deep link ────────
router.post('/:id/telegram-link', verifyToken, async (req, res) => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) return res.status(404).json({ error: 'Brand not found' });

    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
    if (!botUsername) {
      console.error('[members] TELEGRAM_BOT_USERNAME is not set');
      return res.status(500).json({ error: 'Telegram bot is not configured' });
    }

    const { id } = req.params;

    // role comes from the member row (server-side), NEVER from the request.
    const { data: member } = await supabase
      .from('brand_members')
      .select('id, role')
      .eq('id', id)
      .eq('brand_id', brandId)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    const { error } = await supabase
      .from('owner_link_tokens')
      .insert({
        token,
        brand_id: brandId,
        member_id: member.id,
        role: member.role,
        expires_at: expiresAt,
      });

    if (error) throw error;

    return res.status(201).json({
      link: `https://t.me/${botUsername}?start=${token}`,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('[members] telegram-link error:', err.message);
    return res.status(500).json({ error: 'Failed to generate Telegram link' });
  }
});

module.exports = router;
