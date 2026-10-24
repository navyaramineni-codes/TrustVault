const mongoose = require('mongoose');
const { AuditEvent, User, Document } = require('../models');
const { verifyChain } = require('../audit');

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
 * Retrieves audit activity events filtered by multi-criteria options.
 * Guarantees Rule 4 & prompt constraint: "It shows metadata only, never file contents or download links."
 *
 * @param {Object} options - Filtering options (user, document, date, startDate, endDate, from, to, eventType, status)
 * @returns {Promise<{ events: Array<Object>, count: number, total: number }>}
 */
async function getActivityFeed(options = {}) {
  const conditions = [];

  // 1. Filter by User (email or ObjectId)
  const userParam = options.user || options.userId || options.email;
  if (userParam && typeof userParam === 'string' && userParam.trim()) {
    const trimmedUser = userParam.trim();
    const userOr = [];

    // Search inside metadata (e.g. targetEmail, email, targetUserId)
    const escapedUser = trimmedUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    userOr.push({ 'metadata.targetEmail': new RegExp(escapedUser, 'i') });
    userOr.push({ 'metadata.email': new RegExp(escapedUser, 'i') });
    userOr.push({ 'metadata.targetUserId': trimmedUser });

    // If it's an email, find matching user ID
    if (trimmedUser.includes('@')) {
      const foundUser = await User.findOne({ email: trimmedUser.toLowerCase() }).select('_id').lean();
      if (foundUser) {
        userOr.push({ userId: foundUser._id });
        userOr.push({ 'metadata.targetUserId': foundUser._id.toString() });
      }
    } else if (mongoose.Types.ObjectId.isValid(trimmedUser)) {
      const objId = new mongoose.Types.ObjectId(trimmedUser);
      userOr.push({ userId: objId });
      userOr.push({ 'metadata.targetUserId': objId.toString() });
    }

    conditions.push({ $or: userOr });
  }

  // 2. Filter by Document (ObjectId or name keyword)
  const docParam = options.document || options.documentId || options.doc;
  if (docParam && typeof docParam === 'string' && docParam.trim()) {
    const trimmedDoc = docParam.trim();
    const docOr = [];
    const escapedDoc = trimmedDoc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Document name in metadata
    docOr.push({ 'metadata.documentName': new RegExp(escapedDoc, 'i') });
    docOr.push({ 'metadata.name': new RegExp(escapedDoc, 'i') });

    // If valid ObjectId
    if (mongoose.Types.ObjectId.isValid(trimmedDoc)) {
      docOr.push({ documentId: new mongoose.Types.ObjectId(trimmedDoc) });
    }

    // Find documents matching this name in database to include their IDs
    const matchedDocs = await Document.find({
      $or: [
        { name: new RegExp(escapedDoc, 'i') },
        { title: new RegExp(escapedDoc, 'i') },
      ],
    }).select('_id').lean();

    if (matchedDocs.length > 0) {
      const docIds = matchedDocs.map((d) => d._id);
      docOr.push({ documentId: { $in: docIds } });
    }

    conditions.push({ $or: docOr });
  }

  // 3. Filter by Date / Date Range
  const start = options.startDate || options.from || options.createdAfter;
  const end = options.endDate || options.to || options.createdBefore;
  const singleDate = options.date;

  if (start || end) {
    const dateFilter = {};
    if (start) {
      const parsedStart = new Date(start);
      if (!isNaN(parsedStart.getTime())) dateFilter.$gte = parsedStart;
    }
    if (end) {
      let parsedEnd = new Date(end);
      if (typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end.trim())) {
        parsedEnd = new Date(end.trim() + 'T23:59:59.999Z');
      }
      if (!isNaN(parsedEnd.getTime())) dateFilter.$lte = parsedEnd;
    }
    if (Object.keys(dateFilter).length > 0) {
      conditions.push({ timestamp: dateFilter });
    }
  } else if (singleDate) {
    const d = new Date(singleDate);
    if (!isNaN(d.getTime())) {
      const dayStart = new Date(d);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(d);
      dayEnd.setUTCHours(23, 59, 59, 999);
      conditions.push({ timestamp: { $gte: dayStart, $lte: dayEnd } });
    }
  }

  // 4. Filter by Event Type (e.g. PERMISSION_GRANT, PERMISSION_REVOKE)
  const eventTypeParam = options.eventType || options.type;
  if (eventTypeParam) {
    const types = (Array.isArray(eventTypeParam) ? eventTypeParam : String(eventTypeParam).split(','))
      .map((t) => t.trim())
      .filter(Boolean);

    if (types.length === 1) {
      conditions.push({ eventType: types[0] });
    } else if (types.length > 1) {
      conditions.push({ eventType: { $in: types } });
    }
  }

  // 5. Filter by Status (SUCCESS, DENIED, FAILURE)
  if (options.status) {
    conditions.push({ status: String(options.status).toUpperCase().trim() });
  }

  const query = conditions.length > 0 ? { $and: conditions } : {};

  // Execute database query with sequence sorting (latest first)
  const limit = Math.min(parseInt(options.limit, 10) || 100, 500);
  const rawEvents = await AuditEvent.find(query)
    .sort({ sequenceNumber: -1, timestamp: -1 })
    .limit(limit)
    .lean();

  // Pre-load users and documents for metadata enhancement (never content)
  const userIds = [
    ...new Set(
      rawEvents
        .map((e) => e.userId)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
        .map((id) => id.toString())
    ),
  ];
  const docIds = [
    ...new Set(
      rawEvents
        .map((e) => e.documentId)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
        .map((id) => id.toString())
    ),
  ];

  const [foundUsers, foundDocs] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('_id email role').lean(),
    Document.find({ _id: { $in: docIds } }).select('_id name title category mimeType size').lean(),
  ]);

  const userMap = new Map(foundUsers.map((u) => [u._id.toString(), u]));
  const docMap = new Map(foundDocs.map((d) => [d._id.toString(), d]));

  // Sanitize every record: STRICTLY METADATA ONLY, NEVER FILE CONTENTS OR DOWNLOAD LINKS
  const sanitizedEvents = rawEvents.map((evt) => {
    const u = evt.userId ? userMap.get(evt.userId.toString()) : null;
    const d = evt.documentId ? docMap.get(evt.documentId.toString()) : null;

    // Deep clone and clean metadata
    const cleanMeta = { ...(evt.metadata || {}) };
    delete cleanMeta.storagePath;
    delete cleanMeta.fileStorageName;
    delete cleanMeta.filePath;
    delete cleanMeta.content;
    delete cleanMeta.fileContent;
    delete cleanMeta.fileBuffer;
    delete cleanMeta.downloadUrl;
    delete cleanMeta.downloadLink;

    return {
      _id: evt._id,
      sequenceNumber: evt.sequenceNumber,
      timestamp: evt.timestamp,
      eventType: evt.eventType,
      action: evt.action,
      status: evt.status,
      reason: evt.reason || null,
      ipAddress: evt.ipAddress || null,
      userAgent: evt.userAgent || null,
      userId: evt.userId || null,
      userEmail: u ? u.email : (cleanMeta.userEmail || null),
      userRole: u ? u.role : null,
      documentId: evt.documentId || null,
      documentName: d ? (d.name || d.title) : (cleanMeta.documentName || cleanMeta.name || null),
      documentCategory: d ? d.category : (cleanMeta.category || null),
      documentSize: d ? d.size : (cleanMeta.size || cleanMeta.sizeBytes || null),
      documentMimeType: d ? d.mimeType : (cleanMeta.mimeType || null),
      hash: evt.hash,
      previousHash: evt.previousHash,
      metadata: cleanMeta,
    };
  });

  return {
    events: sanitizedEvents,
    count: sanitizedEvents.length,
    total: sanitizedEvents.length,
  };
}

/**
 * Runs cryptographic verification over the audit chain via verifyChain().
 *
 * @returns {Promise<{ isValid: boolean, totalEvents: number, verifiedAt: string, brokenSequence: number|null, error: string|null, latestSequenceNumber: number|null, latestHash: string|null }>}
 */
async function verifyAuditChain() {
  const result = await verifyChain();

  const latestEvent = await AuditEvent.findOne().sort({ sequenceNumber: -1 }).select('sequenceNumber hash').lean();

  return {
    isValid: Boolean(result.valid),
    pass: Boolean(result.valid),
    totalEvents: result.count !== undefined ? result.count : (latestEvent ? latestEvent.sequenceNumber : 0),
    verifiedAt: new Date().toISOString(),
    brokenSequence: result.sequenceNumber || null,
    error: result.error || null,
    latestSequenceNumber: latestEvent ? latestEvent.sequenceNumber : 0,
    latestHash: latestEvent ? latestEvent.hash : null,
  };
}

module.exports = {
  getActivityFeed,
  verifyAuditChain,
  NotFoundError,
};
