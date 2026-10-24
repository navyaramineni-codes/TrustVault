const { AuditEvent } = require('./models');

/**
 * Records an immutable audit log entry.
 * Fulfills Rule 7: "Every state change and every denied attempt writes an audit event via src/audit.js."
 *
 * @param {Object} params
 * @param {string} params.eventType - Categorical type (e.g., 'USER_LOGIN', 'AUTH_FAILED', 'USER_LOGOUT')
 * @param {string|import('mongoose').Types.ObjectId} [params.userId] - User ID if authenticated or identified
 * @param {string|import('mongoose').Types.ObjectId} [params.documentId] - Document ID if applicable
 * @param {string} params.action - Action attempted ('login', 'logout', 'read', 'edit', etc.)
 * @param {'SUCCESS'|'DENIED'|'FAILURE'} params.status - Result of the action
 * @param {string} [params.reason] - Explanation for denial or failure
 * @param {string} [params.ipAddress] - Client IP address
 * @param {string} [params.userAgent] - Client User-Agent string
 * @param {Object} [params.metadata] - Additional contextual metadata (strictly excludes secrets or document content)
 * @returns {Promise<import('./models').AuditEvent|null>}
 */
async function logAuditEvent(params) {
  try {
    const entry = await AuditEvent.create({
      eventType: params.eventType,
      userId: params.userId || null,
      documentId: params.documentId || null,
      action: params.action,
      status: params.status,
      reason: params.reason || null,
      ipAddress: params.ipAddress || null,
      userAgent: params.userAgent || null,
      metadata: params.metadata || {},
    });
    return entry;
  } catch (error) {
    console.error('[Audit] Failed to write audit event:', error.message);
    return null;
  }
}

module.exports = {
  logAuditEvent,
};
