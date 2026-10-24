const express = require('express');
const { verify } = require('@node-rs/argon2');
const { User } = require('../models');
const { logAuditEvent } = require('../audit');

const router = express.Router();

// Constant pre-computed Argon2id hash used to mitigate timing attacks on nonexistent user lookups
const DUMMY_ARGON2_HASH = '$argon2id$v=19$m=19456,t=2,p=1$eW91cnNhbHRoZXJlMDAwMA$lXiC7xqtOXOTeFD3LSWLPar60ViSVd3CpspOJlNJabw';

/**
 * @route   POST /auth/login (also mounted at /api/auth/login)
 * @desc    Authenticate user via email and Argon2 password verification, creating an HttpOnly session
 * @access  Public
 */
router.post('/login', async (req, res, next) => {
  const { email, password } = req.body || {};

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    await logAuditEvent({
      eventType: 'AUTH_FAILED',
      action: 'login',
      status: 'DENIED',
      reason: 'Missing or malformed credentials',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');

    if (!user) {
      // Execute dummy verify to ensure constant time execution regardless of user existence
      await verify(DUMMY_ARGON2_HASH, password).catch(() => false);

      await logAuditEvent({
        eventType: 'AUTH_FAILED',
        action: 'login',
        status: 'DENIED',
        reason: 'Invalid email or password',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        metadata: { attemptedEmail: normalizedEmail },
      });

      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValidPassword = await verify(user.passwordHash, password);

    if (!isValidPassword) {
      await logAuditEvent({
        eventType: 'AUTH_FAILED',
        userId: user._id,
        action: 'login',
        status: 'DENIED',
        reason: 'Invalid email or password',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.isActive) {
      await logAuditEvent({
        eventType: 'AUTH_FAILED',
        userId: user._id,
        action: 'login',
        status: 'DENIED',
        reason: 'Account is deactivated',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      return res.status(401).json({ error: 'Account is deactivated' });
    }

    // Regenerate session ID upon authentication to prevent Session Fixation (CWE-384)
    req.session.regenerate(async (err) => {
      if (err) {
        return next(err);
      }

      req.session.userId = user._id.toString();
      req.session.role = user.role;
      req.session.email = user.email;

      await logAuditEvent({
        eventType: 'USER_LOGIN',
        userId: user._id,
        action: 'login',
        status: 'SUCCESS',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.status(200).json({
        message: 'Login successful',
        user: user.toJSON(),
      });
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /auth/logout (also mounted at /api/auth/logout)
 * @desc    Destroy user session and clear HttpOnly cookie
 * @access  Public / Authenticated
 */
router.post('/logout', async (req, res) => {
  const userId = req.session ? req.session.userId : null;

  if (req.session) {
    req.session.destroy(async (err) => {
      if (err) {
        console.error('[Auth] Failed to destroy session:', err);
      }

      res.clearCookie('trustvault.sid', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });

      if (userId) {
        await logAuditEvent({
          eventType: 'USER_LOGOUT',
          userId: userId,
          action: 'logout',
          status: 'SUCCESS',
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
        });
      }

      res.status(200).json({ message: 'Logout successful' });
    });
  } else {
    res.clearCookie('trustvault.sid');
    res.status(200).json({ message: 'Logout successful' });
  }
});

/**
 * @route   GET /auth/me (also mounted at /api/auth/me)
 * @desc    Retrieve active session user profile
 * @access  Authenticated
 */
router.get('/me', async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await User.findById(req.session.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.status(200).json({
      user: user.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
