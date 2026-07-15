const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { runIvyAgent } = require('../lib/agents/ivy-agent');

// =============================================================================
// TELEGRAM WEBHOOK — binding + inbound dispatch to Ivy
// =============================================================================
// Deep-link binding: an owner generates a single-use token (routes/members.js)
// and forwards https://t.me/<bot>?start=<token>. When the member taps it,
// Telegram sends "/start <token>"; handleStart validates and claims the token
// atomically, then binds this chat_id -> brand_id + role in owner_channels.
//
// Every subsequent message resolves { brand_id, role } SERVER-SIDE from
// owner_channels by chat_id and is dispatched to Ivy. brand_id and role are
// never read from the message.
//
// Register the webhook once with Telegram (secret optional but recommended):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//     -d "url=https://<host>/webhook/telegram" \
//     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
// =============================================================================

// ── Telegram Bot API: send a text message ────────────────────────────────────
// Ivy writes **bold** markdown (money amounts, report headers). Telegram needs
// parse_mode for that, so escape everything else and convert **…** → <b>…</b>.
function toTelegramHtml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

async function sendMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[telegram] TELEGRAM_BOT_TOKEN is not set — cannot send message');
    return;
  }
  const post = (body) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    let resp = await post({ chat_id: chatId, text: toTelegramHtml(text), parse_mode: 'HTML' });
    if (!resp.ok) {
      // Bad entities (400) must never eat the message — retry as plain text.
      const body = await resp.text();
      console.error('[telegram] HTML sendMessage failed, retrying plain:', resp.status, body);
      resp = await post({ chat_id: chatId, text: String(text).replace(/\*\*/g, '') });
      if (!resp.ok) {
        console.error('[telegram] sendMessage failed:', resp.status, await resp.text());
      }
    }
  } catch (err) {
    console.error('[telegram] sendMessage error:', err.message);
  }
}

// ── /start <token> — validate, claim, and bind the channel ───────────────────
async function handleStart(token, chatId, fromId) {
  if (!token) {
    await sendMessage(chatId, 'Please open the invite link your brand owner sent you.');
    return;
  }

  // Atomic single-use claim: only succeeds if the token is unused AND unexpired.
  const { data: claimed, error: claimError } = await supabase
    .from('owner_link_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('token', token)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('brand_id, member_id, role');

  if (claimError) {
    console.error('[telegram] token claim error:', claimError.message);
    await sendMessage(chatId, 'Something went wrong linking your account. Please ask for a fresh link.');
    return;
  }
  if (!claimed || claimed.length === 0) {
    await sendMessage(chatId, 'That link is invalid or has expired. Please ask your brand owner for a new one.');
    return;
  }

  const row = claimed[0];

  const { error: upsertError } = await supabase
    .from('owner_channels')
    .upsert({
      brand_id: row.brand_id,
      member_id: row.member_id,
      role: row.role,
      channel: 'telegram',
      channel_user_id: String(chatId),
      telegram_user_id: fromId != null ? String(fromId) : null,
      verified_at: new Date().toISOString(),
    }, { onConflict: 'channel,channel_user_id' });

  if (upsertError) {
    console.error('[telegram] owner_channels upsert error:', upsertError.message);
    await sendMessage(chatId, 'Something went wrong linking your account. Please ask for a fresh link.');
    return;
  }

  const confirmation = row.role === 'media_buyer'
    ? "Connected. Send me expenses as you make them, e.g. 'spent 5k on ads'."
    : "Connected. I'll handle your finances here.";
  await sendMessage(chatId, confirmation);
}

// ── Handle a normal (non-/start) inbound message ─────────────────────────────
async function handleMessage(chatId, text) {
  const { data: channel } = await supabase
    .from('owner_channels')
    .select('brand_id, role')
    .eq('channel', 'telegram')
    .eq('channel_user_id', String(chatId))
    .maybeSingle();

  if (!channel || !channel.brand_id) {
    await sendMessage(chatId, "You're not linked to a brand yet. Please ask your brand owner for an invite link.");
    return;
  }

  // /report — the fixed report skeleton as one message. Defaults to the week
  // ("/report month" / "/report last month" for months). Owner-only: it
  // contains revenue/profit figures media buyers must never see.
  if (/^\/report\b/.test(text)) {
    if (channel.role !== 'owner') {
      await sendMessage(chatId, "Reports are owner-only — I can log expenses for you though.");
      return;
    }
    try {
      // Lazy require avoids a module cycle (lib/ivy/alerts.js imports this file).
      const { buildReportMessage } = require('../lib/ivy/report');
      const period = /last month/i.test(text) ? 'last_month'
        : /month/i.test(text) ? 'this_month'
        : 'last_7';
      await sendMessage(chatId, await buildReportMessage(channel.brand_id, period));
    } catch (err) {
      console.error('[telegram] /report error:', err.message);
      await sendMessage(chatId, "Sorry, I couldn't pull your report just now. Try again in a moment.");
    }
    return;
  }

  const reply = await runIvyAgent({
    chatId: String(chatId),
    brandId: channel.brand_id,
    role: channel.role,
    userText: text,
  });
  await sendMessage(chatId, reply);
}

// ── Webhook ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // Optional shared-secret check (Telegram sends the header we configured on
  // setWebhook). If a secret is configured, reject anything that doesn't match.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.sendStatus(401);
  }

  // Ack immediately so Telegram doesn't retry while we run the LLM loop.
  res.sendStatus(200);

  try {
    const message = req.body && req.body.message;
    if (!message || !message.chat) return;

    const chatId = message.chat.id;
    const fromId = message.from && message.from.id;
    const text = (message.text || '').trim();
    if (!text) return; // ignore stickers/photos/etc. for now

    if (text.startsWith('/start')) {
      const token = text.split(/\s+/)[1] || '';
      await handleStart(token, chatId, fromId);
      return;
    }

    await handleMessage(chatId, text);
  } catch (err) {
    console.error('[telegram] webhook processing error:', err.message);
  }
});

module.exports = router;
module.exports.sendMessage = sendMessage;
module.exports.handleStart = handleStart;
