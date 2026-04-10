const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { syncTokenToIntegrations } = require('../src/services/metaTokenService');

const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;
const JWT_EXPIRY = '7d';

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET environment variable');
}

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

    // Generate JWT token
    const token = jwt.sign(
      { user_id: newUser.id, email: newUser.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.status(201).json({
      message: 'User created successfully',
      token,
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

    // Generate JWT token
    const token = jwt.sign(
      { user_id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      message: 'Login successful',
      token,
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

    console.log('Auth/me - userId:', userId, 'user:', user, 'error:', fetchError?.message);

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

// ─── Instagram OAuth ────────────────────────────────────────────────

const FACEBOOK_APP_ID = process.env.META_APP_ID;
const FACEBOOK_APP_SECRET = process.env.META_APP_SECRET;
const FACEBOOK_REDIRECT_URI = process.env.FACEBOOK_REDIRECT_URI;
const FRONTEND_DASHBOARD_URL = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')[0].trim()
  : 'http://localhost:3000';
const META_GRAPH_BASE = 'https://graph.facebook.com/v20.0';

/**
 * GET /auth/instagram
 * Redirects the user to Facebook Login with the required scopes.
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
      'instagram_basic',
      'instagram_manage_messages',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_messaging',
      'pages_show_list'
    ].join(',');

    const authUrl = `https://www.facebook.com/v20.0/dialog/oauth`
      + `?client_id=${FACEBOOK_APP_ID}`
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
 * Handles the OAuth callback from Facebook Login.
 * Flow:
 *   1. Exchange code → short-lived user token
 *   2. Exchange short-lived → long-lived user token (60 days)
 *   3. Fetch the brand's Facebook Pages
 *   4. Get the Instagram Business Account ID linked to that page
 *   5. Generate a permanent Page Access Token
 *   6. Save to brands table: page_access_token, instagram_page_id, instagram_business_account_id
 *   7. Redirect to dashboard on success
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
    // Note: Express already URL-decodes req.query values, so no decodeURIComponent needed
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

    // Step 1: Exchange code → short-lived user token
    const tokenUrl = `${META_GRAPH_BASE}/oauth/access_token`
      + `?client_id=${FACEBOOK_APP_ID}`
      + `&client_secret=${FACEBOOK_APP_SECRET}`
      + `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}`
      + `&code=${code}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      console.error(`❌ [${brand_id}] Code exchange failed:`, tokenData.error?.message);
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    const shortLivedToken = tokenData.access_token;
    console.log(`✅ [${brand_id}] Got short-lived user token`);

    // Step 2: Exchange short-lived → long-lived user token (60 days)
    const llUrl = `${META_GRAPH_BASE}/oauth/access_token`
      + `?grant_type=fb_exchange_token`
      + `&client_id=${FACEBOOK_APP_ID}`
      + `&client_secret=${FACEBOOK_APP_SECRET}`
      + `&fb_exchange_token=${shortLivedToken}`;

    const llRes = await fetch(llUrl);
    const llData = await llRes.json();

    if (!llRes.ok || llData.error) {
      console.error(`❌ [${brand_id}] Long-lived token exchange failed:`, llData.error?.message);
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    const longLivedUserToken = llData.access_token;
    const expiresIn = llData.expires_in || 5184000;
    console.log(`✅ [${brand_id}] Got long-lived user token (expires in ${Math.round(expiresIn / 86400)} days)`);

    // Step 3: Fetch the user's Facebook Pages
    const pagesUrl = `${META_GRAPH_BASE}/me/accounts?access_token=${longLivedUserToken}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();

    if (!pagesRes.ok || pagesData.error || !pagesData.data?.length) {
      console.error(`❌ [${brand_id}] Failed to fetch pages:`, pagesData.error?.message || 'No pages found');
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    const page = pagesData.data[0]; // Use the first page
    const pageAccessToken = page.access_token; // This is a permanent page token (derived from long-lived user token)
    const fbPageId = page.id;
    console.log(`📄 [${brand_id}] Using page: ${page.name} (${fbPageId})`);

    // Step 4: Get the Instagram Business Account ID linked to this page
    const igUrl = `${META_GRAPH_BASE}/${fbPageId}?fields=instagram_business_account&access_token=${pageAccessToken}`;
    const igRes = await fetch(igUrl);
    const igData = await igRes.json();

    if (!igRes.ok || igData.error) {
      console.error(`❌ [${brand_id}] Failed to fetch IG business account:`, igData.error?.message);
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    const instagramBusinessAccountId = igData.instagram_business_account?.id || null;
    if (!instagramBusinessAccountId) {
      console.error(`❌ [${brand_id}] No Instagram Business Account linked to page ${fbPageId}`);
      return res.redirect(`${dashboardUrl}?error=instagram_failed`);
    }

    console.log(`📸 [${brand_id}] Instagram Business Account: ${instagramBusinessAccountId}`);

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

    // Step 5: Save to brands table
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const { error: updateError } = await supabase
      .from('brands')
      .update({
        fb_page_id: fbPageId,
        page_access_token: pageAccessToken,
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

    console.log(`✅ [${brand_id}] Saved tokens and IG account to brands table`);

    // Step 6: Sync page token to integrations table
    await syncTokenToIntegrations(brand_id, pageAccessToken);

    // Ensure an integrations row exists so the webhook can find this brand
    const { data: existingIntegration } = await supabase
      .from('integrations')
      .select('id')
      .eq('brand_id', brand_id)
      .eq('platform', 'instagram')
      .maybeSingle();

    if (existingIntegration) {
      await supabase
        .from('integrations')
        .update({ instagram_page_id: instagramBusinessAccountId, access_token: pageAccessToken })
        .eq('id', existingIntegration.id);
    } else {
      const { error: insertError } = await supabase
        .from('integrations')
        .insert({
          brand_id,
          platform: 'instagram',
          instagram_page_id: instagramBusinessAccountId,
          access_token: pageAccessToken
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

module.exports = router;
