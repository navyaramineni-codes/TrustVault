const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Document, Permission, User } = require('../models');
const authz = require('../authz');
const { logAuditEvent } = require('../audit');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage', 'documents');

/**
 * Custom 404 error helper enforcing Rule 3:
 * "Unauthorized access returns 404, never 403."
 */
class NotFoundError extends Error {
  constructor(message = 'Not Found') {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
    this.statusCode = 404;
  }
}

/**
 * Custom 400 error helper for malformed client inputs.
 */
class BadRequestError extends Error {
  constructor(message = 'Bad Request') {
    super(message);
    this.name = 'BadRequestError';
    this.status = 400;
    this.statusCode = 400;
  }
}

/**
 * Denies access, writes an audit event, and throws a 404 error.
 */
async function denyAndThrow(user, documentId, action, reason) {
  await logAuditEvent({
    eventType: 'ACCESS_DENIED',
    userId: user?._id || null,
    documentId: documentId || null,
    action: action || 'unknown',
    status: 'DENIED',
    reason: reason || 'Access denied',
  });
  throw new NotFoundError('Not Found');
}

/**
 * Persists file binary into MongoDB GridFS bucket for cloud container persistence.
 */
async function saveToGridFS(filename, buffer, metadata = {}) {
  try {
    if (!mongoose.connection || !mongoose.connection.db) return;
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'document_files' });
    const uploadStream = bucket.openUploadStream(filename, { metadata });
    await new Promise((resolve, reject) => {
      uploadStream.on('finish', resolve);
      uploadStream.on('error', reject);
      uploadStream.end(buffer);
    });
  } catch (err) {
    console.warn('[GridFS] Backup note:', err.message);
  }
}

/**
 * Retrieve a document by ID and verify authorization for the requested action.
 * Fulfills Rule 2: "Every document access goes through authorize(user, doc, action) in src/authz.js.
 * Routes never query the documents collection directly."
 *
 * @param {Object} user - The authenticated user object
 * @param {string|mongoose.Types.ObjectId} documentId - The document ID
 * @param {string} action - The action requested ('read', 'edit', 'delete', 'grant')
 * @returns {Promise<Document>} The authorized document instance
 */
async function getDocumentById(user, documentId, action) {
  if (!documentId || !mongoose.Types.ObjectId.isValid(documentId)) {
    return denyAndThrow(user, null, action, 'Invalid document ID format');
  }

  const doc = await Document.findById(documentId);
  if (!doc) {
    return denyAndThrow(user, null, action, 'Document not found');
  }

  // Enforce Policy Decision Point check (Rule 2, 3, 4, 5)
  await authz.authorize(user, doc, action);

  return doc;
}

/**
 * Create a new document record and write a success audit event.
 *
 * @param {Object} params
 * @returns {Promise<Document>}
 */
async function createDocument({
  user,
  name,
  title,
  description,
  category,
  tags,
  storagePath,
  fileStorageName,
  originalFileName,
  mimeType,
  size,
  sizeBytes,
  sha256,
  ipAddress,
  userAgent,
}) {
  const docName = name || title || path.parse(originalFileName || '').name || 'Untitled Document';
  const docStoragePath = storagePath || fileStorageName;
  const docSize = size !== undefined ? size : sizeBytes;

  const document = await Document.create({
    name: docName,
    title: docName,
    description: description || '',
    category: category || 'general',
    tags: tags || [],
    storagePath: docStoragePath,
    fileStorageName: docStoragePath,
    originalFileName: originalFileName || docName,
    mimeType,
    size: docSize,
    sizeBytes: docSize,
    sha256,
    owner: user._id,
    ownerId: user._id,
    deletedAt: null,
  });

  await logAuditEvent({
    eventType: 'DOCUMENT_CREATE',
    userId: user._id,
    documentId: document._id,
    action: 'create',
    status: 'SUCCESS',
    ipAddress,
    userAgent,
    metadata: {
      name: document.name,
      title: document.title,
      category: document.category,
      sha256: document.sha256,
      size: document.size,
      sizeBytes: document.sizeBytes,
      mimeType: document.mimeType,
    },
  });

  return document;
}

/**
 * List all documents accessible to the requesting user, optionally filtered by search criteria.
 * Fulfills Rule 6: "Search is permission-filtered inside the database query, never in JS after fetching."
 *
 * @param {Object} user - The authenticated user object
 * @param {Object|string} options - Search or filter options (e.g. { search, q, name, owner, category, startDate, endDate })
 * @returns {Promise<Array<Document>>}
 */
async function listDocuments(user, options = {}) {
  if (!user || !user._id) {
    throw new NotFoundError('Unauthorized');
  }

  const opts = typeof options === 'string' ? { search: options } : (options || {});

  // 1. Query all active permissions granted to this user
  const permissions = await Permission.find({ userId: user._id }).select('documentId').lean();
  const grantedDocIds = permissions.map((p) => p.documentId);

  // 2. Base conditions: active (not deleted) AND permission-filtered (owned OR granted)
  const conditions = [
    { deletedAt: null },
    {
      $or: [
        { owner: user._id },
        { ownerId: user._id },
        { _id: { $in: grantedDocIds } },
      ],
    },
  ];

  // 3. Search by Name / Title
  const nameTerm = opts.name || opts.title;
  if (nameTerm && typeof nameTerm === 'string' && nameTerm.trim()) {
    const term = nameTerm.trim();
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(escapedTerm, 'i');
    conditions.push({
      $or: [
        { name: nameRegex },
        { title: nameRegex },
        { originalFileName: nameRegex },
      ],
    });
  }

  // 4. Search by Owner (Email, Username prefix, or User ID)
  const ownerParam = opts.owner || opts.ownerId;
  if (ownerParam && typeof ownerParam === 'string' && ownerParam.trim()) {
    const cleanOwner = ownerParam.toLowerCase().trim();
    const resolvedOwnerIds = [];

    if (mongoose.Types.ObjectId.isValid(cleanOwner)) {
      resolvedOwnerIds.push(new mongoose.Types.ObjectId(cleanOwner));
    }

    const escapedOwner = cleanOwner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchedUsers = await User.find({
      email: new RegExp(cleanOwner.includes('@') ? `^${escapedOwner}$` : `^${escapedOwner}(@|$)`, 'i'),
    }).select('_id').lean();

    matchedUsers.forEach((u) => {
      if (!resolvedOwnerIds.some((id) => id.equals(u._id))) {
        resolvedOwnerIds.push(u._id);
      }
    });

    if (resolvedOwnerIds.length > 0) {
      conditions.push({
        $or: [
          { owner: { $in: resolvedOwnerIds } },
          { ownerId: { $in: resolvedOwnerIds } },
        ],
      });
    } else {
      // Specified owner does not exist; match nothing
      conditions.push({ _id: new mongoose.Types.ObjectId() });
    }
  }

  // 5. Search by Category
  const categoryParam = opts.category;
  if (categoryParam && typeof categoryParam === 'string' && categoryParam.trim()) {
    const cat = categoryParam.trim();
    const escapedCat = cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    conditions.push({
      category: new RegExp(`^${escapedCat}$`, 'i'),
    });
  }

  // 6. Search by Date Range (startDate, endDate, from, to, createdAfter, createdBefore)
  const startParam = opts.startDate || opts.from || opts.createdAfter;
  const endParam = opts.endDate || opts.to || opts.createdBefore;
  if (startParam || endParam) {
    const dateFilter = {};
    if (startParam) {
      const parsedStart = new Date(startParam);
      if (!isNaN(parsedStart.getTime())) {
        dateFilter.$gte = parsedStart;
      }
    }
    if (endParam) {
      let parsedEnd = new Date(endParam);
      if (!isNaN(parsedEnd.getTime())) {
        if (typeof endParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endParam.trim())) {
          parsedEnd = new Date(endParam.trim() + 'T23:59:59.999Z');
        }
        dateFilter.$lte = parsedEnd;
      }
    }
    if (Object.keys(dateFilter).length > 0) {
      conditions.push({ createdAt: dateFilter });
    }
  }

  // 7. General search term (q, search, query)
  const generalTerm = opts.search || opts.q || opts.query;
  if (generalTerm && typeof generalTerm === 'string' && generalTerm.trim()) {
    const term = generalTerm.trim();
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedTerm, 'i');
    conditions.push({
      $or: [
        { name: searchRegex },
        { title: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
        { tags: searchRegex },
        { originalFileName: searchRegex },
      ],
    });
  }

  // Construct combined database query: permission filter + search criteria inside MongoDB query
  const query = { $and: conditions };

  // Execute database query directly
  const documents = await Document.find(query)
    .populate('owner', 'email')
    .sort({ createdAt: -1 });

  return documents;
}

/**
 * Search accessible documents using permission-filtered database queries.
 *
 * @param {Object} user - The authenticated user object
 * @param {Object|string} criteria - Search criteria or search term string
 * @returns {Promise<Array<Document>>}
 */
async function searchDocuments(user, criteria) {
  const options = typeof criteria === 'string' ? { q: criteria } : (criteria || {});
  return listDocuments(user, options);
}


/**
 * Prepares a document for streamed download through the application.
 *
 * @param {Object} user - The authenticated user object
 * @param {string} documentId - The document ID
 * @param {Object} context - Optional IP / UserAgent context
 * @returns {Promise<{ document: Document, filePath: string, stream: fs.ReadStream }>}
 */
async function getDownloadStream(user, documentId, context = {}) {
  const doc = await getDocumentById(user, documentId, 'read');

  const fileName = doc.storagePath || doc.fileStorageName;
  const filePath = path.join(STORAGE_DIR, fileName);

  let fileAvailable = false;
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    fileAvailable = true;
  } catch {
    // If not found on local disk (e.g. Render cloud container restart/redeploy),
    // attempt self-healing restoration from MongoDB GridFS
    try {
      if (mongoose.connection && mongoose.connection.db) {
        const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'document_files' });
        const matchingFiles = await bucket.find({ filename: fileName }).toArray();
        if (matchingFiles.length > 0) {
          await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
          const downloadStream = bucket.openDownloadStreamByName(fileName);
          await new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(filePath);
            downloadStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
          });
          fileAvailable = true;
        }
      }
    } catch (gridFsErr) {
      console.warn('[Storage] GridFS restore note:', gridFsErr.message);
    }
  }

  if (!fileAvailable) {
    await logAuditEvent({
      eventType: 'DOWNLOAD_FAILED',
      userId: user._id,
      documentId: doc._id,
      action: 'read',
      status: 'FAILURE',
      reason: 'Physical file not found on disk',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw new NotFoundError('File not found on storage');
  }

  // Rule 7: Record audit event on document download
  await logAuditEvent({
    eventType: 'DOCUMENT_DOWNLOAD',
    userId: user._id,
    documentId: doc._id,
    action: 'read',
    status: 'SUCCESS',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      name: doc.name,
      fileName: doc.originalFileName || doc.name,
      size: doc.size,
      sizeBytes: doc.sizeBytes,
      sha256: doc.sha256,
    },
  });

  const stream = fs.createReadStream(filePath);
  return {
    document: doc,
    filePath,
    stream,
  };
}

/**
 * Edit document metadata (name, title, description, category, tags) after verifying 'edit' authorization.
 *
 * @param {Object} user - The authenticated user object
 * @param {string} documentId - The document ID
 * @param {Object} updates - Metadata updates { name, title, description, category, tags }
 * @param {Object} context - IP / UserAgent context
 * @returns {Promise<Document>}
 */
async function updateDocumentMetadata(user, documentId, updates = {}, context = {}) {
  const doc = await getDocumentById(user, documentId, 'edit');

  const previousTitle = doc.title || doc.name;
  const previousDescription = doc.description;

  if (updates.name !== undefined) {
    const trimmed = String(updates.name).trim();
    if (trimmed) {
      doc.name = trimmed;
      doc.title = trimmed;
    }
  }

  if (updates.title !== undefined) {
    const trimmedTitle = String(updates.title).trim();
    if (trimmedTitle) {
      doc.title = trimmedTitle;
      if (!updates.name) {
        doc.name = trimmedTitle;
      }
    }
  }

  if (updates.description !== undefined) {
    doc.description = String(updates.description);
  }

  if (updates.category !== undefined) {
    const trimmedCategory = String(updates.category).trim();
    if (trimmedCategory) {
      doc.category = trimmedCategory;
    }
  }

  if (updates.tags !== undefined) {
    if (Array.isArray(updates.tags)) {
      doc.tags = updates.tags.map((t) => String(t).trim()).filter(Boolean);
    } else if (typeof updates.tags === 'string') {
      doc.tags = updates.tags.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }

  await doc.save();

  // Rule 7: Every state change writes an audit event
  await logAuditEvent({
    eventType: 'DOCUMENT_UPDATE',
    userId: user._id,
    documentId: doc._id,
    action: 'edit',
    status: 'SUCCESS',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      previousTitle,
      newTitle: doc.title,
      previousDescription,
      newDescription: doc.description,
    },
  });

  return doc;
}

/**
 * Soft-delete a document by setting deletedAt timestamp.
 * Retains MongoDB document record so audit logs can continue referencing it.
 * Reserved exclusively for document owners.
 *
 * @param {Object} user - The authenticated user object
 * @param {string} documentId - The document ID
 * @param {Object} context - IP / UserAgent context
 * @returns {Promise<{ message: string }>}
 */
async function deleteDocument(user, documentId, context = {}) {
  const doc = await getDocumentById(user, documentId, 'delete');

  // Soft delete: record deletion timestamp and retain MongoDB record for audit log references
  doc.deletedAt = new Date();
  await doc.save();

  // Rule 7: Every state change writes an audit event
  await logAuditEvent({
    eventType: 'DOCUMENT_DELETE',
    userId: user._id,
    documentId: doc._id,
    action: 'delete',
    status: 'SUCCESS',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      deletedName: doc.name,
      deletedTitle: doc.title,
      storagePath: doc.storagePath,
      fileStorageName: doc.fileStorageName,
      sha256: doc.sha256,
      deletedAt: doc.deletedAt,
    },
  });

  return { message: 'Document deleted successfully' };
}

/**
 * Grant or update permissions on a document for a target user.
 * Enforces Rule 2 (goes through authorize(user, doc, 'grant')) and Rule 4 (only owner can grant).
 *
 * @param {Object} user - The authenticated requesting user
 * @param {string} documentId - The document ID
 * @param {Object} params - { userId, email, level }
 * @param {Object} context - IP / UserAgent context
 * @returns {Promise<{ message: string, permission: Object }>}
 */
async function grantPermission(user, documentId, { userId, email, name, username, user: userParam, level } = {}, context = {}) {
  // Enforce Rule 2: Access via authorize(user, doc, 'grant') - owner-only
  const doc = await getDocumentById(user, documentId, 'grant');

  const permLevel = String(level || '').toLowerCase().trim();
  if (!permLevel || !['read', 'edit'].includes(permLevel)) {
    throw new BadRequestError('Invalid permission level. Must be "read" or "edit"');
  }

  const identifier = userId || email || name || username || userParam;
  if (!identifier) {
    throw new BadRequestError('User identifier (name or email) is required');
  }

  let targetUser;
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    targetUser = await User.findById(userId);
  }

  if (!targetUser) {
    const cleanStr = String(identifier).toLowerCase().trim();
    targetUser = await User.findOne({ email: cleanStr });

    if (!targetUser) {
      const escaped = cleanStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      targetUser = await User.findOne({ email: new RegExp('^' + escaped + '(@|$)', 'i') });
    }
  }

  if (!targetUser) {
    throw new NotFoundError('User not found');
  }

  // Prevent granting to document owner
  const docOwnerId = doc.ownerId || doc.owner;
  if (docOwnerId && targetUser._id.equals(docOwnerId)) {
    throw new BadRequestError('Document owner already possesses full access');
  }

  const permission = await Permission.findOneAndUpdate(
    { documentId: doc._id, userId: targetUser._id },
    {
      documentId: doc._id,
      userId: targetUser._id,
      level: permLevel,
      grantedBy: user._id,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Rule 7: Every state change writes an audit event
  await logAuditEvent({
    eventType: 'PERMISSION_GRANT',
    userId: user._id,
    documentId: doc._id,
    action: 'grant',
    status: 'SUCCESS',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      targetUserId: targetUser._id,
      targetEmail: targetUser.email,
      level,
    },
  });

  return {
    message: 'Permission granted successfully',
    permission: {
      ...permission.toJSON(),
      email: targetUser.email,
      name: targetUser.email ? targetUser.email.split('@')[0] : 'User',
    },
  };
}

/**
 * List all active permissions granted on a document.
 * Enforces Rule 2 (goes through authorize(user, doc, 'grant')) and Rule 4 (only owner can grant/manage permissions).
 *
 * @param {Object} user - The authenticated requesting user
 * @param {string} documentId - The document ID
 * @returns {Promise<Array<Object>>}
 */
async function listDocumentPermissions(user, documentId, context = {}) {
  // Enforce Rule 2: Access via authorize(user, doc, 'grant') - owner-only
  const doc = await getDocumentById(user, documentId, 'grant');

  const permissions = await Permission.find({ documentId: doc._id })
    .populate('userId', 'email role')
    .sort({ createdAt: -1 });

  return permissions.map((p) => {
    const pUserId = p.userId?._id ? p.userId._id.toString() : (p.userId ? p.userId.toString() : '');
    const userEmail = p.userId?.email || 'Unknown User';
    return {
      _id: p._id.toString(),
      userId: pUserId,
      email: userEmail,
      name: userEmail.split('@')[0],
      role: p.userId?.role || 'user',
      level: p.level,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}

/**
 * Revoke permission on a document for a target user.
 * Enforces Rule 2 (goes through authorize(user, doc, 'grant')) and Rule 4 (only owner can revoke).
 *
 * @param {Object} user - The authenticated requesting user
 * @param {string} documentId - The document ID
 * @param {string} targetUserId - The target user ID or email to revoke
 * @param {Object} context - IP / UserAgent context
 * @returns {Promise<{ message: string }>}
 */
async function revokePermission(user, documentId, targetUserId, context = {}) {
  // Enforce Rule 2: Access via authorize(user, doc, 'grant') - owner-only
  const doc = await getDocumentById(user, documentId, 'grant');

  if (!targetUserId) {
    throw new NotFoundError('User not found');
  }

  let resolvedUserId = targetUserId;
  if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
    const targetUser = await User.findOne({ email: String(targetUserId).toLowerCase().trim() });
    if (!targetUser) {
      throw new NotFoundError('User not found');
    }
    resolvedUserId = targetUser._id;
  }

  await Permission.deleteOne({
    documentId: doc._id,
    userId: resolvedUserId,
  });

  // Rule 7: Every state change writes an audit event
  await logAuditEvent({
    eventType: 'PERMISSION_REVOKE',
    userId: user._id,
    documentId: doc._id,
    action: 'grant',
    status: 'SUCCESS',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      targetUserId: resolvedUserId.toString(),
    },
  });

  return { message: 'Permission revoked successfully' };
}

/**
 * Replace a document's physical file with a new file.
 * Records old and new SHA-256 hashes and emits a FILE_REPLACE audit event.
 *
 * @param {Object} user - Authenticated user object
 * @param {string} documentId - Document ID
 * @param {Object} fileData - { fileBuffer, originalFileName, mimeType, size }
 * @param {Object} context - IP / UserAgent context
 * @returns {Promise<Document>}
 */
async function replaceDocumentFile(user, documentId, { fileBuffer, originalFileName, mimeType, size } = {}, context = {}) {
  // Enforce Rule 2: Access via authorize(user, doc, 'edit')
  const doc = await getDocumentById(user, documentId, 'edit');

  if (!fileBuffer || fileBuffer.length === 0) {
    throw new BadRequestError('Empty file buffer provided for replacement');
  }

  const oldSha256 = doc.sha256;
  const newSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const newFileStorageName = crypto.randomUUID();

  // Write new file to storage
  await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
  const targetPath = path.join(STORAGE_DIR, newFileStorageName);
  await fs.promises.writeFile(targetPath, fileBuffer);

  // Backup replacement file to GridFS
  await saveToGridFS(newFileStorageName, fileBuffer, {
    documentId: doc._id,
    mimeType: mimeType || doc.mimeType,
    sha256: newSha256,
  });

  // Update document properties
  const oldFileName = doc.originalFileName;
  doc.fileStorageName = newFileStorageName;
  doc.storagePath = newFileStorageName;
  doc.sha256 = newSha256;
  doc.size = size !== undefined ? size : fileBuffer.length;
  doc.sizeBytes = doc.size;
  if (mimeType) {
    doc.mimeType = mimeType;
  }
  if (originalFileName) {
    doc.originalFileName = originalFileName;
  }
  doc.updatedAt = new Date();

  await doc.save();

  // Rule 7: Record audit event with old and new SHA-256
  await logAuditEvent({
    eventType: 'FILE_REPLACE',
    userId: user._id,
    documentId: doc._id,
    action: 'replace',
    status: 'SUCCESS',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      oldSha256,
      newSha256,
      oldFileName,
      newFileName: doc.originalFileName,
      size: doc.size,
    },
  });

  return doc;
}

module.exports = {
  NotFoundError,
  BadRequestError,
  getDocumentById,
  createDocument,
  listDocuments,
  searchDocuments,
  getDownloadStream,
  updateDocumentMetadata,
  deleteDocument,
  grantPermission,
  revokePermission,
  listDocumentPermissions,
  replaceDocumentFile,
  saveToGridFS,
};

