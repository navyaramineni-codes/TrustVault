const { Permission } = require('./models');
const { logAuditEvent } = require('./audit');

/**
 * Custom Authorization Error enforcing Rule 3:
 * "Unauthorized access returns 404, never 403."
 */
class AuthorizationError extends Error {
  constructor(message = 'Not Found') {
    super(message);
    this.name = 'AuthorizationError';
    this.status = 404;
    this.statusCode = 404;
  }
}

const SUPPORTED_ACTIONS = Object.freeze(['read', 'edit', 'delete', 'grant']);

/**
 * Helper to securely compare ObjectIds, strings, or populated references.
 */
function areIdsEqual(id1, id2) {
  if (!id1 || !id2) return false;
  if (typeof id1.equals === 'function') {
    return id1.equals(id2);
  }
  if (typeof id2.equals === 'function') {
    return id2.equals(id1);
  }
  return id1.toString() === id2.toString();
}

/**
 * Logs a denied authorization event and throws a 404 AuthorizationError.
 * Fulfills Rule 3 ("returns 404, never 403") and Rule 7 ("writes an audit event on denied attempts").
 */
async function deny(user, doc, action, reason) {
  await logAuditEvent({
    eventType: 'ACCESS_DENIED',
    userId: user?._id || null,
    documentId: doc?._id || null,
    action: typeof action === 'string' ? action : 'unknown',
    status: 'DENIED',
    reason: reason || 'Unauthorized access',
  });

  throw new AuthorizationError('Not Found');
}

/**
 * Centralized authorization engine for TrustVault document access.
 * Fulfills RULES.md:
 * - Rule 2: Every document access goes through authorize(user, doc, action) in src/authz.js.
 * - Rule 3: Unauthorized access returns 404, never 403.
 * - Rule 4: Viewers: read when granted read; read and edit when granted edit; delete and grant always denied.
 *           Only the owner can delete or grant. Admin has no automatic access to document contents.
 *
 * @param {Object|null} user - The requesting user object (must have _id and isActive: true)
 * @param {Object|null} doc - The target document object (must have _id and ownerId)
 * @param {string} action - The requested action ('read', 'edit', 'delete', 'grant')
 * @returns {Promise<boolean>} Resolves to true if authorized, or throws 404 AuthorizationError if denied.
 */
async function authorize(user, doc, action) {
  // 1. Validate action string against supported operations
  if (!action || typeof action !== 'string' || !SUPPORTED_ACTIONS.includes(action)) {
    return deny(user, doc, action, 'Invalid or unsupported action requested');
  }

  // 2. Validate document existence
  const docOwner = doc ? (doc.owner || doc.ownerId) : null;
  if (!doc || !doc._id || !docOwner) {
    return deny(user, doc, action, 'Document not found or missing required ownership metadata');
  }

  // 2b. Validate document has not been soft-deleted (deleted documents return 404 for everyone)
  if (doc.deletedAt) {
    return deny(user, doc, action, 'Document has been deleted');
  }

  // 3. Validate user authentication and active account status
  if (!user || !user._id || user.isActive === false) {
    return deny(user, doc, action, 'User unauthenticated or account is deactivated');
  }

  // Extract owner ID (supports both raw ObjectId/string and populated user document)
  const docOwnerId = docOwner._id || docOwner;
  const isOwner = areIdsEqual(user._id, docOwnerId);

  // 4. Owner Authorization (Rule 4: Only the owner can delete or grant; owner has full access)
  if (isOwner) {
    return true;
  }

  // 5. Non-Owner Constraints (Rule 4: Viewers delete and grant always denied. Only owner can delete or grant.)
  if (action === 'delete' || action === 'grant') {
    return deny(
      user,
      doc,
      action,
      `Action "${action}" is reserved exclusively for the document owner`
    );
  }

  // 6. Admin Access Constraint (Rule 4: Admin has no automatic access to document contents)
  // Even if user.role === 'admin', without ownership they must possess an explicit grant

  // 7. Viewer Permission Check for 'read' and 'edit'
  const permission = await Permission.findOne({
    documentId: doc._id,
    userId: user._id,
  });

  if (!permission) {
    return deny(user, doc, action, 'No permission granted for this document');
  }

  // Viewer with 'edit' grant: permitted to read and edit
  if (permission.level === 'edit') {
    if (action === 'read' || action === 'edit') {
      return true;
    }
  }

  // Viewer with 'read' grant: permitted to read only
  if (permission.level === 'read') {
    if (action === 'read') {
      return true;
    }
    return deny(user, doc, action, 'Edit action not permitted with read-only grant');
  }

  // Any other unexpected permission level is denied
  return deny(user, doc, action, 'Unauthorized permission level');
}

module.exports = authorize;
module.exports.authorize = authorize;
module.exports.AuthorizationError = AuthorizationError;
