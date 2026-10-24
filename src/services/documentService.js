const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Document, Permission } = require('../models');
const { authorize } = require('../authz');
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
  await authorize(user, doc, action);

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
  title,
  description,
  fileStorageName,
  originalFileName,
  mimeType,
  sizeBytes,
  sha256,
  ipAddress,
  userAgent,
}) {
  const document = await Document.create({
    title: title || path.parse(originalFileName).name || 'Untitled Document',
    description: description || '',
    fileStorageName,
    originalFileName,
    mimeType,
    sizeBytes,
    sha256,
    ownerId: user._id,
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
      title: document.title,
      sha256: document.sha256,
      sizeBytes: document.sizeBytes,
      mimeType: document.mimeType,
    },
  });

  return document;
}

/**
 * List all documents accessible to the requesting user.
 * Fulfills Rule 6: "Search is permission-filtered inside the database query, never in JS after fetching."
 *
 * @param {Object} user - The authenticated user object
 * @returns {Promise<Array<Document>>}
 */
async function listDocuments(user) {
  if (!user || !user._id) {
    throw new NotFoundError('Unauthorized');
  }

  // 1. Query all active permissions granted to this user
  const permissions = await Permission.find({ userId: user._id }).select('documentId');
  const grantedDocIds = permissions.map((p) => p.documentId);

  // 2. Perform database-level permission filtering inside the MongoDB query
  const query = {
    $or: [
      { ownerId: user._id },
      { _id: { $in: grantedDocIds } },
    ],
  };

  const documents = await Document.find(query).sort({ createdAt: -1 });

  // 3. Double-check authorize() for defense-in-depth
  const authorizedDocs = [];
  for (const doc of documents) {
    try {
      await authorize(user, doc, 'read');
      authorizedDocs.push(doc);
    } catch {
      // Exclude documents that do not pass authorization
    }
  }

  return authorizedDocs;
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

  const filePath = path.join(STORAGE_DIR, doc.fileStorageName);

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
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
      fileName: doc.originalFileName,
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
 * Edit document metadata (title and description) after verifying 'edit' authorization.
 *
 * @param {Object} user - The authenticated user object
 * @param {string} documentId - The document ID
 * @param {Object} updates - Metadata updates { title, description }
 * @param {Object} context - IP / UserAgent context
 * @returns {Promise<Document>}
 */
async function updateDocumentMetadata(user, documentId, updates = {}, context = {}) {
  const doc = await getDocumentById(user, documentId, 'edit');

  const previousTitle = doc.title;
  const previousDescription = doc.description;

  if (updates.title !== undefined) {
    const trimmedTitle = String(updates.title).trim();
    if (trimmedTitle) {
      doc.title = trimmedTitle;
    }
  }

  if (updates.description !== undefined) {
    doc.description = String(updates.description);
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
 * Delete a document, its physical storage file, and associated permissions.
 * Reserved exclusively for document owners.
 *
 * @param {Object} user - The authenticated user object
 * @param {string} documentId - The document ID
 * @param {Object} context - IP / UserAgent context
 * @returns {Promise<{ message: string }>}
 */
async function deleteDocument(user, documentId, context = {}) {
  const doc = await getDocumentById(user, documentId, 'delete');

  // 1. Remove physical file from disk
  const filePath = path.join(STORAGE_DIR, doc.fileStorageName);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    // File may already have been unlinked or missing; proceed with DB deletion
  }

  // 2. Remove permissions granted on this document
  await Permission.deleteMany({ documentId: doc._id });

  // 3. Remove document record from database
  await Document.deleteOne({ _id: doc._id });

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
      deletedTitle: doc.title,
      fileStorageName: doc.fileStorageName,
      sha256: doc.sha256,
    },
  });

  return { message: 'Document deleted successfully' };
}

module.exports = {
  NotFoundError,
  getDocumentById,
  createDocument,
  listDocuments,
  getDownloadStream,
  updateDocumentMetadata,
  deleteDocument,
};
