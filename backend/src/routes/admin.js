const express = require('express');
const mongoose = require('mongoose');
const { hash } = require('@node-rs/argon2');
const { User } = require('../models');
const { logAuditEvent } = require('../audit');

const router = express.Router();

/**
 * Terminate all active sessions for a target user across both in-memory and database stores.
 *
 * @param {Object} sessionStore - The Express session store (MemoryStore or MongoStore)
 * @param {string|mongoose.Types.ObjectId} userId - The user ID whose sessions must be invalidated
 */
async function endUserSessions(sessionStore, userId) {
  const strUserId = userId.toString();

  // 1. Destroy sessions in memory / sessionStore interface
  if (sessionStore && typeof sessionStore.all === 'function') {
    await new Promise((resolve) => {
      sessionStore.all((err, sessions) => {
        if (!err && sessions) {
          const destroyPromises = [];
          for (const [sid, sessData] of Object.entries(sessions)) {
            try {
              const parsed = typeof sessData === 'string' ? JSON.parse(sessData) : sessData;
              if (parsed && parsed.userId && parsed.userId.toString() === strUserId) {
                destroyPromises.push(
                  new Promise((res) => sessionStore.destroy(sid, res))
                );
              }
            } catch {}
          }
          Promise.all(destroyPromises).then(resolve);
        } else {
          resolve();
        }
      });
    });
  } else if (sessionStore && sessionStore.sessions) {
    for (const [sid, sessData] of Object.entries(sessionStore.sessions)) {
      try {
        const parsed = typeof sessData === 'string' ? JSON.parse(sessData) : sessData;
        if (parsed && parsed.userId && parsed.userId.toString() === strUserId) {
          delete sessionStore.sessions[sid];
        }
      } catch {}
    }
  }

  // 2. Destroy sessions in MongoDB collection if connect-mongo is active
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      await mongoose.connection.collection('sessions').deleteMany({
        $or: [
          { 'session.userId': strUserId },
          { session: new RegExp(`"userId"\\s*:\\s*"${strUserId}"`) },
        ],
      });
    } catch {}
  }
}

/**
 * Admin authorization guard middleware.
 * Enforces requirement: "Non-admins get 404" (and Rule 3: Unauthorized access returns 404, never 403).
 */
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    await logAuditEvent({
      eventType: 'ACCESS_DENIED',
      userId: null,
      action: 'admin_access',
      status: 'DENIED',
      reason: 'Unauthenticated attempt to access admin interface',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return res.status(404).json({ error: 'Not Found' });
  }

  try {
    const user = await User.findById(req.session.userId);
    if (!user || user.isActive === false || user.role !== 'admin') {
      await logAuditEvent({
        eventType: 'ACCESS_DENIED',
        userId: req.session.userId,
        action: 'admin_access',
        status: 'DENIED',
        reason: 'Unauthorized non-admin attempt to access admin interface',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(404).json({ error: 'Not Found' });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

// Apply requireAdmin guard to all admin user management routes
router.use(requireAdmin);

/**
 * @route   POST /admin/users
 * @desc    Create a new user with Argon2id hashed password
 * @access  Admin-Only (Non-admins get 404)
 */
router.post('/', async (req, res, next) => {
  const { email, password, role } = req.body || {};

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const emailRegex = /^\S+@\S+\.\S+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Invalid email address format' });
  }

  const userRole = role !== undefined ? role : 'user';
  if (!['user', 'admin'].includes(userRole)) {
    return res.status(400).json({ error: 'Invalid role. Must be either "user" or "admin"' });
  }

  try {
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const passwordHash = await hash(password);

    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      role: userRole,
      isActive: true,
    });

    // Rule 7: Record audit event for user creation
    await logAuditEvent({
      eventType: 'USER_CREATE',
      userId: req.user._id,
      action: 'create_user',
      status: 'SUCCESS',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      metadata: {
        createdUserId: user._id,
        createdEmail: user.email,
        createdRole: user.role,
      },
    });

    res.status(201).json({
      message: 'User created successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @route   PATCH /admin/users/:id/role
 * @desc    Change a user's role (user <-> admin)
 * @access  Admin-Only (Non-admins get 404)
 */
router.patch('/:id/role', async (req, res, next) => {
  const { id } = req.params;
  const { role } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ error: 'Not Found' });
  }

  if (!role || !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be either "user" or "admin"' });
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'Not Found' });
    }

    const oldRole = user.role;
    user.role = role;
    await user.save();

    await logAuditEvent({
      eventType: 'ROLE_CHANGE',
      userId: req.user._id,
      action: 'role_change',
      status: 'SUCCESS',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      metadata: {
        targetUserId: user._id,
        targetEmail: user.email,
        oldRole,
        newRole: role,
      },
    });

    res.status(200).json({
      message: 'User role updated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

// Alias PUT /admin/users/:id/role to PATCH
router.put('/:id/role', async (req, res, next) => {
  const { id } = req.params;
  const { role } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ error: 'Not Found' });
  }

  if (!role || !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be either "user" or "admin"' });
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'Not Found' });
    }

    const oldRole = user.role;
    user.role = role;
    await user.save();

    await logAuditEvent({
      eventType: 'ROLE_CHANGE',
      userId: req.user._id,
      action: 'role_change',
      status: 'SUCCESS',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      metadata: {
        targetUserId: user._id,
        targetEmail: user.email,
        oldRole,
        newRole: role,
      },
    });

    res.status(200).json({
      message: 'User role updated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /admin/users/:id/disable
 * @desc    Disable a user and immediately invalidate all their active sessions
 * @access  Admin-Only (Non-admins get 404)
 */
router.post('/:id/disable', async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ error: 'Not Found' });
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'Not Found' });
    }

    user.isActive = false;
    await user.save();

    // Immediately terminate active sessions
    await endUserSessions(req.sessionStore, user._id);

    await logAuditEvent({
      eventType: 'USER_DISABLE',
      userId: req.user._id,
      action: 'disable_user',
      status: 'SUCCESS',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      metadata: {
        targetUserId: user._id,
        targetEmail: user.email,
      },
    });

    res.status(200).json({
      message: 'User disabled successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

// Alias PATCH /admin/users/:id/disable to POST
router.patch('/:id/disable', async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ error: 'Not Found' });
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'Not Found' });
    }

    user.isActive = false;
    await user.save();

    // Immediately terminate active sessions
    await endUserSessions(req.sessionStore, user._id);

    await logAuditEvent({
      eventType: 'USER_DISABLE',
      userId: req.user._id,
      action: 'disable_user',
      status: 'SUCCESS',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      metadata: {
        targetUserId: user._id,
        targetEmail: user.email,
      },
    });

    res.status(200).json({
      message: 'User disabled successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});


/**
 * General PATCH /admin/users/:id endpoint supporting role update or disabling
 */
router.patch('/:id', async (req, res, next) => {
  const { id } = req.params;
  const { role, isActive } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ error: 'Not Found' });
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'Not Found' });
    }

    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be either "user" or "admin"' });
      }
      user.role = role;
    }

    if (isActive !== undefined) {
      user.isActive = Boolean(isActive);
      if (user.isActive === false) {
        await endUserSessions(req.sessionStore, user._id);
      }
    }

    await user.save();

    res.status(200).json({
      message: 'User updated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.endUserSessions = endUserSessions;
