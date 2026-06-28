const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { syncTokenToIntegrations } = require('../src/services/metaTokenService');

const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;
// bcrypt cost for refresh token verifier hashing (lower than passwords — tokens are
// already high-entropy random bytes, so we just need breach-resistance, not slow KDF)
const VERIFIER_BCRYPT_ROUNDS = 10;

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET environment variable');
}

/**
 * Issue an access token + opaque refresh token for a given user.
 *
 * Security model — selector/verifier split:
 *   selector      16 random bytes (hex) — stored plain, used to locate the DB row
 *   verifier      32 random bytes (hex) — the secret; only its bcrypt hash is stored
 *   client token  "<selector>.<verifier>" — opaque, never reconstructable from the DB
 *
 * Even if the DB is fully leaked, an attacker cannot reverse a verifier hash into
 * a usable refresh token.
 */
async function issueTokenPair(userId, email) {
  const accessToken = jwt.sign(
    { user_id: userId, email, type: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  const selector = crypto.randomBytes(16).toString('hex');   // 32 hex chars — public lookup key
  const verifier = crypto.randomBytes(32).toString('hex');   // 64 hex chars — secret
  const verifierHash = await bcrypt.hash(verifier, VERIFIER_BCRYPT_ROUNDS);

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('refresh_tokens')
    .insert({ user_id: userId, selector, verifier_hash: verifierHash, expires_at: expiresAt });

  if (error) {
    console.error('Failed to store refresh token:', error);
    throw new Error('Failed to issue session');
  }

  // Return the opaque token the client will store: "<selector>.<verifier>"
  const refreshToken = `${selector}.${verifier}`;
  return { accessToken, refreshToken };
}

/**
 * POST /auth/check-email
 * Check if an email is already registered (used during signup step 0)
 */
router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    return res.status(200).json({ exists: !!existingUser });
  } catch (err) {
    console.error('Check email error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /auth/signup
 * Register a new user
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, first_name, last_name, business_name } = req.body;

    // Debug logging
    console.log('Signup request body:', { email, first_name, last_name, business_name });
    console.log('Extracted fields:', { email, first_name, last_name, business_name });

    // Validate required fields
    if (!email || !password || !first_name || !last_name || !business_name) {
      return res.status(400).json({
        error: 'Missing required fields: email, password, first_name, last_name, business_name',
        received: { email, first_name, last_name, business_name }
      });
    }

    // Check if user already exists
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Create a brand for the user
    const { data: newBrand, error: brandError } = await supabase
      .from('brands')
      .insert([
        {
          name: business_name
        }
      ])
      .select('id')
      .single();

    if (brandError) {
      console.error('Error creating brand:', brandError);
      return res.status(500).json({ error: 'Failed to create brand' });
    }

    // Insert new user into database with brand_id
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([
        {
          email,
          password: hashedPassword,
          first_name,
          last_name,
          business_name,
          brand_id: newBrand.id
        }
      ])
      .select('id, email, brand_id')
      .single();

    if (insertError) {
      console.error('Error inserting user:', insertError);
      // Cleanup: delete the brand if user creation fails
      await supabase.from('brands').delete().eq('id', newBrand.id);
      return res.status(500).json({ error: 'Failed to create user account' });
    }

    const { accessToken, refreshToken } = await issueTokenPair(newUser.id, newUser.email);

    res.status(201).json({
      message: 'User created successfully',
      token: accessToken,
      refreshToken,
      user: {
        user_id: newUser.id,
        email: newUser.email
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/login
 * Authenticate user and return JWT
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Fetch user from database
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, email, password')
      .eq('email', email)
      .single();

    if (fetchError || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Compare password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.email);

    res.json({
      message: 'Login successful',
      token: accessToken,
      refreshToken,
      user: {
        user_id: user.id,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/onboarding
 * Update brand's onboarding information (protected route)
 */
router.post('/onboarding', verifyToken, async (req, res) => {
  try {
    const { business_type, revenue_range, dm_volume, pain_point, brand_description } = req.body;
    const userId = req.user.user_id;

    // Validate that at least one field is provided
    if (!business_type && !revenue_range && !dm_volume && !pain_point && !brand_description) {
      return res.status(400).json({
        error: 'At least one field is required: business_type, revenue_range, dm_volume, pain_point, brand_description'
      });
    }

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(400).json({ error: 'No brand found for this user' });
    }

    // Build update object with only provided fields
    const updateData = {};
    if (business_type !== undefined) updateData.business_type = business_type;
    if (revenue_range !== undefined) updateData.revenue_range = revenue_range;
    if (dm_volume !== undefined) updateData.dm_volume = dm_volume;
    if (pain_point !== undefined) updateData.pain_point = pain_point;
    if (brand_description !== undefined) updateData.brand_description = brand_description;

    // Update brand in database
    const { data: updatedBrand, error: updateError } = await supabase
      .from('brands')
      .update(updateData)
      .eq('id', user.brand_id)
      .select('id, name, business_type, revenue_range, dm_volume, pain_point, brand_description')
      .single();

    if (updateError) {
      console.error('Error updating brand:', updateError);
      return res.status(500).json({ error: 'Failed to update brand information' });
    }

    res.json({
      message: 'Onboarding information updated successfully',
      brand: updatedBrand
    });
  } catch (error) {
    console.error('Onboarding error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /auth/me
 * Get authenticated user's profile with brand data (protected route)
 */
router.get('/me', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Fetch user with brand data via join
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select(`
        id, email, first_name, last_name, business_name, brand_id, created_at,
        brands:brand_id (
          id, name, business_type, revenue_range, dm_volume, pain_point, brand_description,
          instagram_business_account_id, fb_page_id
        )
      `)
      .eq('id', userId)
      .maybeSingle();

    if (fetchError) console.error('Auth/me error:', fetchError.message);

    if (fetchError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Flatten brand data into user response for backward compatibility
    const brand = user.brands || {};
    const response = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      business_name: user.business_name,
      brand_id: user.brand_id,
      created_at: user.created_at,
      business_type: brand.business_type || null,
      revenue_range: brand.revenue_range || null,
      dm_volume: brand.dm_volume || null,
      pain_point: brand.pain_point || null,
      brand_description: brand.brand_description || null,
      instagram_connected: !!brand.instagram_business_account_id,
      fb_page_connected: !!brand.fb_page_id,
    };

    res.json({ user: response });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /auth/brand-description
 * Update the brand description (used from settings page)
 */
router.put('/brand-description', verifyToken, async (req, res) => {
  try {
    const { brand_description } = req.body;
    const userId = req.user.user_id;

    if (brand_description === undefined || brand_description === null) {
      return res.status(400).json({ error: 'brand_description is required' });
    }

    // Look up the user's brand_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('brand_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.brand_id) {
      return res.status(400).json({ error: 'No brand found for this user' });
    }

    const { data: updatedBrand, error: updateError } = await supabase
      .from('brands')
      .update({ brand_description })
      .eq('id', user.brand_id)
      .select('id, brand_description')
      .single();

    if (updateError) {
      console.error('Error updating brand description:', updateError);
      return res.status(500).json({ error: 'Failed to update brand description' });
    }

    res.json({
      message: 'Brand description updated successfully',
      brand_description: updatedBrand.brand_description
    });
  } catch (error) {
    console.error('Brand description update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/refresh
 * Exchange a valid refresh token for a new access token + rotated refresh token.
 * The old token row is deleted immediately (single-use rotation).
 *
 * Expects body: { refreshToken: "<selector>.<verifier>" }
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken || !refreshToken.includes('.')) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  const dotIndex = refreshToken.indexOf('.');
  const selector = refreshToken.slice(0, dotIndex);
  const verifier = refreshToken.slice(dotIndex + 1);

  if (!selector || !verifier) {
    return res.status(403).json({ error: 'Invalid refresh token' });
  }

  // Look up the row by selector (plain-text, indexed)
  const { data: storedToken, error: fetchError } = await supabase
    .from('refresh_tokens')
    .select('id, user_id, verifier_hash, expires_at')
    .eq('selector', selector)
    .maybeSingle();

  if (fetchError || !storedToken) {
    return res.status(403).json({ error: 'Refresh token not recognised' });
  }

  // Check DB-level expiry (defence-in-depth on top of the expires_at column)
  if (new Date(storedToken.expires_at) < new Date()) {
    await supabase.from('refresh_tokens').delete().eq('id', storedToken.id);
    return res.status(401).json({ error: 'Refresh token expired' });
  }

  // Constant-time bcrypt comparison of the secret verifier
  const verifierValid = await bcrypt.compare(verifier, storedToken.verifier_hash);
  if (!verifierValid) {
    // Possible token theft — delete the row to invalidate the session entirely
    await supabase.from('refresh_tokens').delete().eq('id', storedToken.id);
    return res.status(403).json({ error: 'Invalid refresh token' });
  }

  // Delete the used row before issuing the new pair (rotation)
  await supabase.from('refresh_tokens').delete().eq('id', storedToken.id);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, email')
    .eq('id', storedToken.user_id)
    .single();

  if (userError || !user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const { accessToken, refreshToken: newRefreshToken } = await issueTokenPair(user.id, user.email);

  res.json({ token: accessToken, refreshToken: newRefreshToken });
});

/**
 * POST /auth/logout
 * Revoke the refresh token by selector so it can no longer be used.
 * Expects body: { refreshToken: "<selector>.<verifier>" }
 */
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;

  if (refreshToken && refreshToken.includes('.')) {
    const selector = refreshToken.slice(0, refreshToken.indexOf('.'));
    await supabase.from('refresh_tokens').delete().eq('selector', selector);
  }

  res.json({ message: 'Logged out' });
});

// ─── Instagram OAuth ────────────────────────────────────────────────

const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
const FACEBOOK_REDIRECT_URI = process.env.FACEBOOK_REDIRECT_URI;
const FRONTEND_DASHBOARD_URL = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')[0].trim()
  : 'http://localhost:3000';
const INSTAGRAM_GRAPH_BASE = 'https://graph.instagram.com';

/**
 * GET /auth/instagram
 * Redirects the user to Instagram OAuth authorization.
 * Expects ?brand_id=xxx as a query param so we know which brand to update on callback.
 */
router.get('/instagram', (req, res) => {
  try {
    const brandId = req.query.brand_id;
    const token = req.query.token;

    if (!brandId || !token) {
      return res.redirect(`${FRONTEND_DASHBOARD_URL}/dashboard?error=instagram_failed`);
    }

    // Verify the JWT manually (browser redirects can't send Authorization headers)
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.redirect(`${FRONTEND_DASHBOARD_URL}/dashboard?error=instagram_failed`);
    }

    // Encode brand_id + user_id in the state param so the callback knows which brand to update
    const state = Buffer.from(JSON.stringify({
      brand_id: brandId,
      user_id: decoded.user_id
    })).toString('base64');

    const scopes = [
      'instagram_business_basic',
      'instagram_business_manage_messages'
    ].join(',');

    const authUrl = `https://www.instagram.com/oauth/authorize`
      + `?client_id=${INSTAGRAM_APP_ID}`
      + `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}`
      + `&scope=${scopes}`
      + `&state=${encodeURIComponent(state)}`
      + `&response_type=code`;

    res.redirect(authUrl);
  } catch (error) {
    console.error('Instagram OAuth redirect error:', error);
    res.redirect(`${FRONTEND_DASHBOARD_URL}/dashboard?error=instagram_failed`);
  }
});

/**
 * GET /auth/instagram/callback
 * Handles the OAuth callback from Instagram Business Login.
 * Flow:
 *   1. Exchange code → short-lived Instagram user token
 *   2. Exchange short-lived → long-lived Instagram user token (60 days)
 *   3. Fetch the Instagram user's ID and username via /me
 *   4. Save to brands table: long_lived_user_token, instagram_business_account_id
 *   5. Upsert integrations row so the webhook can find this brand
 *   6. Redirect to dashboard on success
 *
 * NOTE: Instagram Business Login does NOT issue Page Access Tokens.
 *       The long-lived Instagram user token is used directly for DM replies
 *       via the /{ig-user-id}/messages endpoint.
 */
router.get('/instagram/callback', async (req, res) => {
  const dashboardUrl = `${FRONTEND_DASHBOARD_URL}/dashboard`;

  try {
    const { code, state, error: fbError } = req.query;

    if (fbError || !code || !state) {
      console.error('Instagram callback missing params:', { fbError, hasCode: !!code, hasState: !!state });
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    // Decode state to get brand_id
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch {
      console.error('Invalid state parameter');
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    const { brand_id } = stateData;
    if (!brand_id) {
      console.error('No brand_id in state');
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    console.log(`🔑 [${brand_id}] Instagram OAuth callback - exchanging code for tokens...`);

    // Step 1: Exchange code → short-lived Instagram user token
    const tokenUrl = `https://api.instagram.com/oauth/access_token`;

    console.log(`📋 [${brand_id}] Token exchange: client_id=${INSTAGRAM_APP_ID}, redirect_uri=${FACEBOOK_REDIRECT_URI}, code=${code.substring(0, 20)}...`);

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: FACEBOOK_REDIRECT_URI,
        code
      })
    });
    const tokenData = await tokenRes.json();

    console.log(`📋 [${brand_id}] Token exchange response:`, JSON.stringify(tokenData));

    if (!tokenRes.ok || tokenData.error_type || tokenData.error) {
      console.error(`❌ [${brand_id}] Code exchange failed:`, tokenData.error_message || tokenData.error?.message || JSON.stringify(tokenData));
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    const shortLivedToken = tokenData.access_token;
    console.log(`✅ [${brand_id}] Got short-lived Instagram user token`);

    // Step 2: Exchange short-lived → long-lived Instagram user token (60 days)
    const llUrl = `${INSTAGRAM_GRAPH_BASE}/access_token`
      + `?grant_type=ig_exchange_token`
      + `&client_secret=${INSTAGRAM_APP_SECRET}`
      + `&access_token=${shortLivedToken}`;

    const llRes = await fetch(llUrl);
    const llData = await llRes.json();

    if (!llRes.ok || llData.error) {
      console.error(`❌ [${brand_id}] Long-lived token exchange failed:`, llData.error?.message || JSON.stringify(llData));
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    const longLivedUserToken = llData.access_token;
    const expiresIn = llData.expires_in || 5184000;
    console.log(`✅ [${brand_id}] Got long-lived Instagram user token (expires in ${Math.round(expiresIn / 86400)} days)`);

    // Step 3: Fetch the Instagram user's ID and username
    const meUrl = `${INSTAGRAM_GRAPH_BASE}/v21.0/me?fields=user_id,name,username&access_token=${longLivedUserToken}`;
    const meRes = await fetch(meUrl);
    const meData = await meRes.json();

    if (!meRes.ok || meData.error) {
      console.error(`❌ [${brand_id}] Failed to fetch Instagram user info:`, meData.error?.message);
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    // user_id is the app-scoped IG user ID; id is the graph node ID
    const instagramBusinessAccountId = meData.user_id || meData.id;
    const instagramUsername = meData.username || meData.name || null;

    if (!instagramBusinessAccountId) {
      console.error(`❌ [${brand_id}] Could not determine Instagram Business Account ID from /me response:`, JSON.stringify(meData));
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    console.log(`📸 [${brand_id}] Instagram Business Account: ${instagramBusinessAccountId} (@${instagramUsername})`);

    // Check if this Instagram account is already connected to another brand
    const { data: existingIg } = await supabase
      .from('integrations')
      .select('brand_id')
      .eq('instagram_page_id', instagramBusinessAccountId)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (existingIg && existingIg.brand_id !== brand_id) {
      console.error(`❌ [${brand_id}] Instagram account ${instagramBusinessAccountId} is already connected to brand ${existingIg.brand_id}`);
      return res.redirect(`${dashboardUrl}?error=instagram_already_connected`);
    }

    // Step 4: Save to brands table
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const { error: updateError } = await supabase
      .from('brands')
      .update({
        fb_page_id: null,
        page_access_token: longLivedUserToken,
        long_lived_user_token: longLivedUserToken,
        token_expires_at: expiresAt,
        instagram_page_id: instagramBusinessAccountId,
        instagram_business_account_id: instagramBusinessAccountId
      })
      .eq('id', brand_id);

    if (updateError) {
      console.error(`❌ [${brand_id}] Failed to save to brands:`, updateError.message);
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    console.log(`✅ [${brand_id}] Saved Instagram token and account to brands table`);

    // Step 5: Upsert integrations row so the webhook can find this brand
    const { data: existingIntegration } = await supabase
      .from('integrations')
      .select('id')
      .eq('brand_id', brand_id)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (existingIntegration) {
      await supabase
        .from('integrations')
        .update({ instagram_page_id: instagramBusinessAccountId, access_token: longLivedUserToken })
        .eq('id', existingIntegration.id);
    } else {
      const { error: insertError } = await supabase
        .from('integrations')
        .insert({
          brand_id,
          platform: 'instagram',
          instagram_page_id: instagramBusinessAccountId,
          access_token: longLivedUserToken
        });

      if (insertError) {
        console.error(`⚠️ [${brand_id}] Failed to insert integration:`, insertError.message);
      }
    }

    console.log(`✅ [${brand_id}] Instagram OAuth complete!`);
    res.redirect(`${dashboardUrl}?instagram=connected`);

  } catch (error) {
    console.error('Instagram OAuth callback error:', error);
    res.redirect(`${dashboardUrl}?error=instagram_failed`);
  }
});

// ─── Supabase Auth — user provisioning ──────────────────────────────────────

/**
 * POST /auth/supabase/ensure-user
 *
 * Called by the frontend after:
 *   - Google OAuth callback (new or returning user)
 *   - Email OTP verification (new user completing onboarding)
 *
 * Validates the Supabase access_token from the Authorization header, then
 * ensures a row exists in our `users` and `brands` tables for that Auth user.
 * Safe to call multiple times — returns the existing row if already present.
 *
 * Body (only required when creating a new user):
 *   { first_name?, last_name?, business_name? }
 *
 * NOTE: If the `users.password` column has a NOT NULL constraint in your DB,
 * you will need to run:
 *   ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
 * before Supabase OAuth/OTP users can be inserted (they have no password).
 */
router.post('/supabase/ensure-user', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // Validate the Supabase access token
  const { data: { user: supabaseUser }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !supabaseUser) {
    return res.status(401).json({ error: 'Invalid or expired Supabase session' });
  }

  // Check if this email is already in our users table
  const { data: existing } = await supabase
    .from('users')
    .select('id, email, first_name, last_name, business_name, brand_id')
    .eq('email', supabaseUser.email)
    .maybeSingle();

  if (existing) {
    // If the caller is supplying fields that are still empty (e.g. brand name collected
    // after the initial callback call), update them so onboarding data is never lost.
    const { first_name: bodyFn, last_name: bodyLn, business_name: bodyBn } = req.body || {};
    const patch = {};
    if (bodyFn && (!existing.first_name || existing.first_name === 'User')) patch.first_name = bodyFn;
    if (bodyLn && !existing.last_name) patch.last_name = bodyLn;
    if (bodyBn && !existing.business_name) patch.business_name = bodyBn;

    if (Object.keys(patch).length > 0) {
      await supabase.from('users').update(patch).eq('id', existing.id);
      if (patch.business_name && existing.brand_id) {
        await supabase.from('brands').update({ name: patch.business_name }).eq('id', existing.brand_id);
      }
    }

    return res.json({ user: { ...existing, ...patch }, isNew: false });
  }

  // ── New user — create users + brands rows ────────────────────────────────
  const { first_name, last_name, business_name } = req.body || {};

  // Fall back to Google/OAuth metadata when the onboarding fields aren't provided yet
  const meta = supabaseUser.user_metadata || {};
  const fn = first_name || meta.full_name?.split(' ')[0] || meta.name?.split(' ')[0] || 'User';
  const ln = last_name || meta.full_name?.split(' ').slice(1).join(' ') || meta.name?.split(' ').slice(1).join(' ') || '';
  const bn = business_name || '';

  const { data: newBrand, error: brandError } = await supabase
    .from('brands')
    .insert([{ name: bn || fn }])
    .select('id')
    .single();

  if (brandError) {
    console.error('[ensure-user] Failed to create brand:', brandError.message);
    return res.status(500).json({ error: 'Failed to create brand' });
  }

  const userRow = {
    email: supabaseUser.email,
    password: null, // OAuth/OTP users have no password in our table
    first_name: fn,
    last_name: ln,
    business_name: bn,
    brand_id: newBrand.id,
  };

  let { data: newUser, error: insertError } = await supabase
    .from('users')
    .insert([userRow])
    .select('id, email, first_name, last_name, business_name, brand_id')
    .single();

  // If password column has NOT NULL constraint (pre-migration), retry with a UUID sentinel.
  // Run `ALTER TABLE users ALTER COLUMN password DROP NOT NULL;` to clean this up.
  if (insertError && insertError.code === '23502') {
    const { data: retryUser, error: retryError } = await supabase
      .from('users')
      .insert([{ ...userRow, password: require('crypto').randomUUID() }])
      .select('id, email, first_name, last_name, business_name, brand_id')
      .single();
    insertError = retryError;
    newUser = retryUser;
  }

  if (insertError) {
    console.error('[ensure-user] Failed to create user:', insertError.message);
    // Roll back the brand row so we don't leave orphans
    await supabase.from('brands').delete().eq('id', newBrand.id);
    return res.status(500).json({ error: 'Failed to create user account' });
  }

  return res.status(201).json({ user: newUser, isNew: true });
});

module.exports = router;
