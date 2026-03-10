const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

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
    console.log('Signup request body:', req.body);
    console.log('Extracted fields:', { email, password, first_name, last_name, business_name });

    // Validate required fields
    if (!email || !password || !first_name || !last_name || !business_name) {
      return res.status(400).json({
        error: 'Missing required fields: email, password, first_name, last_name, business_name',
        received: { email, password, first_name, last_name, business_name }
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

    // Insert new user into database
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([
        {
          email,
          password: hashedPassword,
          first_name,
          last_name,
          business_name
        }
      ])
      .select('id, email')
      .single();

    if (insertError) {
      console.error('Error inserting user:', insertError);
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
 * Update user's onboarding information (protected route)
 */
router.post('/onboarding', verifyToken, async (req, res) => {
  try {
    const { business_type, revenue_range, dm_volume, pain_point } = req.body;
    const userId = req.user.user_id;

    // Validate that at least one field is provided
    if (!business_type && !revenue_range && !dm_volume && !pain_point) {
      return res.status(400).json({
        error: 'At least one field is required: business_type, revenue_range, dm_volume, pain_point'
      });
    }

    // Build update object with only provided fields
    const updateData = {};
    if (business_type !== undefined) updateData.business_type = business_type;
    if (revenue_range !== undefined) updateData.revenue_range = revenue_range;
    if (dm_volume !== undefined) updateData.dm_volume = dm_volume;
    if (pain_point !== undefined) updateData.pain_point = pain_point;

    // Update user in database
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select('id, email, business_type, revenue_range, dm_volume, pain_point')
      .single();

    if (updateError) {
      console.error('Error updating user:', updateError);
      return res.status(500).json({ error: 'Failed to update user information' });
    }

    res.json({
      message: 'Onboarding information updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Onboarding error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /auth/me
 * Get authenticated user's profile (protected route)
 */
router.get('/me', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Fetch user from database, excluding password
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, business_name, business_type, revenue_range, dm_volume, pain_point, created_at')
      .eq('id', userId)
      .single();

    if (fetchError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
