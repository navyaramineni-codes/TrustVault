const express = require('express');
const { User } = require('../models');
const { logAuditEvent } = require('../audit');
const adminService = require('../services/adminService');
const { renderAdminDashboardHtml } = require('../views/adminDashboardHtml');

const router = express.Router();

/**
 * Admin authorization guard middleware.
 * Enforces Rule 3 ("Unauthorized access returns 404, never 403") and "Non-admins get 404".
 */
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    await logAuditEvent({
      eventType: 'ACCESS_DENIED',
      userId: null,
      action: 'admin_dashboard_access',
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
        action: 'admin_dashboard_access',
        status: 'DENIED',
        reason: 'Unauthorized non-admin attempt to access admin dashboard',
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

// Protect all admin dashboard endpoints
router.use(requireAdmin);

/**
 * @route   GET /admin (also mounted at /api/admin)
 * @desc    Render the interactive Admin Console Single Page Application
 * @access  Admin-Only (Non-admins get 404 per Rule 3)
 */
router.get('/', (req, res) => {
  // If API client explicitly requests application/json, return API documentation/status
  if (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html')) {
    return res.status(200).json({
      message: 'TrustVault Admin API',
      user: req.user.email,
      endpoints: [
        '/admin/activity',
        '/admin/permissions/history',
        '/admin/verify-chain',
      ],
    });
  }

  const html = renderAdminDashboardHtml(req.user);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
});

// Alias /admin/dashboard and /admin/console to root
router.get('/dashboard', (req, res) => res.redirect('/admin'));
router.get('/console', (req, res) => res.redirect('/admin'));

/**
 * @route   GET /admin/activity (also aliased at /admin/events)
 * @desc    Retrieve activity feed filtered by user, document, date, and event type.
 *          Rule 4 & Prompt Guarantee: Shows metadata only, never file contents or download links.
 * @access  Admin-Only (Non-admins get 404)
 */
async function handleActivityFeed(req, res, next) {
  try {
    const result = await adminService.getActivityFeed(req.query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
router.get('/activity', handleActivityFeed);
router.get('/events', handleActivityFeed);

/**
 * @route   GET /admin/permissions/history (also aliased at /admin/permissions)
 * @desc    Retrieve permission-change history (grants and revokes) filtered by user, document, date.
 *          Rule 4 & Prompt Guarantee: Shows metadata only, never file contents or download links.
 * @access  Admin-Only (Non-admins get 404)
 */
async function handlePermissionHistory(req, res, next) {
  try {
    const filterOptions = {
      ...req.query,
      eventType: ['PERMISSION_GRANT', 'PERMISSION_REVOKE'],
    };
    const result = await adminService.getActivityFeed(filterOptions);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
router.get('/permissions/history', handlePermissionHistory);
router.get('/permissions', handlePermissionHistory);

/**
 * @route   POST /admin/verify-chain (and GET /admin/verify-chain)
 * @desc    Runs cryptographic verification over the audit event hash chain via verifyChain()
 * @access  Admin-Only (Non-admins get 404)
 */
async function handleVerifyChain(req, res, next) {
  try {
    const verification = await adminService.verifyAuditChain();
    res.status(200).json(verification);
  } catch (error) {
    next(error);
  }
}
router.post('/verify-chain', handleVerifyChain);
router.get('/verify-chain', handleVerifyChain);

module.exports = router;
