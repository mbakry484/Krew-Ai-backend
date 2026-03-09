const express = require('express');
const router = express.Router();
// const bcrypt = require('bcrypt');
// const jwt = require('jsonwebtoken');
// const supabase = require('../lib/supabase');

// TODO: Implement authentication routes
// - POST /auth/register - User registration
// - POST /auth/login - User login
// - POST /auth/refresh - Refresh JWT token
// - POST /auth/logout - User logout

router.post('/register', (req, res) => {
  res.status(501).json({ message: 'Registration endpoint not yet implemented' });
});

router.post('/login', (req, res) => {
  res.status(501).json({ message: 'Login endpoint not yet implemented' });
});

router.post('/refresh', (req, res) => {
  res.status(501).json({ message: 'Refresh token endpoint not yet implemented' });
});

router.post('/logout', (req, res) => {
  res.status(501).json({ message: 'Logout endpoint not yet implemented' });
});

module.exports = router;
