const crypto = require('crypto');
const mongoose = require('mongoose');
const { AuditEvent } = require('./models');

const GENESIS_PREVIOUS_HASH = '0'.repeat(64);

const AUDIT_APP_USER_CONFIG = {
  username: process.env.MONGO_AUDIT_USER || 'audit_app_user',
  password: process.env.MONGO_AUDIT_PASSWORD || 'AuditAppPassword2026!',
  role: 'auditInsertFindOnly',
};

/**
 * Recursively sorts keys of an object to produce deterministic serialization.
 *
 * @param {*} value
 * @returns {*}
 */
function sortObjectKeys(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof mongoose.Types.ObjectId) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortObjectKeys(value[key]);
  }
  return sorted;
}

/**
 * Produces a deterministic canonical representation of the audit event's content.
 *
 * @param {Object} event
 * @returns {string}
 */
function canonicalizeContent(event) {
  const timestamp = event.timestamp instanceof Date
    ? event.timestamp.toISOString()
    : new Date(event.timestamp || Date.now()).toISOString();

  const payload = {
    sequenceNumber: Number(event.sequenceNumber),
    timestamp,
    eventType: String(event.eventType || ''),
    userId: event.userId ? event.userId.toString() : null,
    documentId: event.documentId ? event.documentId.toString() : null,
    action: String(event.action || ''),
    status: String(event.status || ''),
    reason: event.reason !== undefined && event.reason !== null ? String(event.reason) : null,
    ipAddress: event.ipAddress !== undefined && event.ipAddress !== null ? String(event.ipAddress) : null,
    userAgent: event.userAgent !== undefined && event.userAgent !== null ? String(event.userAgent) : null,
    metadata: sortObjectKeys(event.metadata || {}),
  };

  return JSON.stringify(payload);
}

/**
 * Calculates SHA-256 digest of previousHash + canonicalContent.
 *
 * @param {string} previousHash
 * @param {string} contentStr
 * @returns {string}
 */
function calculateHash(previousHash, contentStr) {
  return crypto
    .createHash('sha256')
    .update(`${previousHash}:${contentStr}`)
    .digest('hex');
}

/**
 * Records an immutable audit log entry into the cryptographic hash chain.
 * Concurrency protection: If multiple concurrent writes attempt to insert the same sequenceNumber,
 * MongoDB's unique index rejects the conflict with E11000, triggering an automatic retry that
 * recalculates sequence and previousHash against the newly committed head of the chain.
 *
 * @param {Object} params
 * @param {number} [retries=15]
 * @returns {Promise<import('./models').AuditEvent>}
 */
async function logAuditEvent(params, retries = 15) {
  // Ensure AuditEvent model indexes (specifically unique sequenceNumber) are built
  await AuditEvent.init().catch(() => {});

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Find current latest event in the linear chain
      const lastEvent = await AuditEvent.findOne()
        .sort({ sequenceNumber: -1 })
        .select('sequenceNumber hash')
        .lean();

      const sequenceNumber = lastEvent && typeof lastEvent.sequenceNumber === 'number'
        ? lastEvent.sequenceNumber + 1
        : 1;

      const previousHash = lastEvent && lastEvent.hash
        ? lastEvent.hash
        : GENESIS_PREVIOUS_HASH;

      const timestamp = params.timestamp || new Date();

      const eventPayload = {
        sequenceNumber,
        timestamp,
        eventType: params.eventType,
        userId: params.userId || null,
        documentId: params.documentId || null,
        action: params.action,
        status: params.status,
        reason: params.reason || null,
        ipAddress: params.ipAddress || null,
        userAgent: params.userAgent || null,
        metadata: params.metadata || {},
        previousHash,
      };

      const contentStr = canonicalizeContent(eventPayload);
      const hash = calculateHash(previousHash, contentStr);
      eventPayload.hash = hash;

      const entry = await AuditEvent.create(eventPayload);
      return entry;
    } catch (error) {
      const isDuplicateKey = error.code === 11000 || (error.message && error.message.includes('E11000'));
      if (isDuplicateKey) {
        if (attempt === retries - 1) {
          console.error('[Audit] Concurrency conflict on sequenceNumber, max retries reached');
          throw error;
        }
        // Jittered backoff to distribute concurrent retries
        const jitter = Math.floor(Math.random() * 25) + 10;
        await new Promise((res) => setTimeout(res, jitter));
        continue;
      }

      console.error('[Audit] Failed to write audit event:', error.message);
      throw error;
    }
  }
}

/**
 * Validates the cryptographic integrity of the entire audit chain.
 * Verifies that:
 * 1. Sequence numbers start at 1 and are strictly contiguous (no gaps or forks).
 * 2. Genesis block points to standard 64-zero previousHash.
 * 3. Every subsequent block's previousHash matches prior block's hash.
 * 4. Recomputed SHA-256 of (previousHash + canonical content) matches stored hash.
 *
 * @returns {Promise<{ valid: boolean, count: number, error?: string, sequenceNumber?: number }>}
 */
async function verifyChain() {
  const events = await AuditEvent.find().sort({ sequenceNumber: 1 });

  if (!events || events.length === 0) {
    return { valid: true, count: 0 };
  }

  let expectedPrevHash = GENESIS_PREVIOUS_HASH;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const expectedSeq = i + 1;

    // 1. Verify linear contiguous sequence (detect gaps and missing rows)
    if (event.sequenceNumber !== expectedSeq) {
      return {
        valid: false,
        error: `Sequence gap detected: expected ${expectedSeq}, but found ${event.sequenceNumber}`,
        sequenceNumber: event.sequenceNumber,
        index: i,
      };
    }

    // 2. Verify previousHash pointer
    if (event.previousHash !== expectedPrevHash) {
      return {
        valid: false,
        error: `Hash pointer broken at sequence ${event.sequenceNumber}: expected previousHash ${expectedPrevHash}, but found ${event.previousHash}`,
        sequenceNumber: event.sequenceNumber,
        index: i,
      };
    }

    // 3. Recompute hash and detect any content alterations
    const contentStr = canonicalizeContent(event);
    const computedHash = calculateHash(event.previousHash, contentStr);

    if (computedHash !== event.hash) {
      return {
        valid: false,
        error: `Hash mismatch at sequence ${event.sequenceNumber}: event content has been tampered with`,
        sequenceNumber: event.sequenceNumber,
        expectedHash: computedHash,
        actualHash: event.hash,
        index: i,
      };
    }

    expectedPrevHash = event.hash;
  }

  return {
    valid: true,
    count: events.length,
  };
}

/**
 * Creates a dedicated MongoDB app user with custom role restricted strictly to
 * 'insert' and 'find' operations on the auditevents collection.
 *
 * @param {import('mongoose').Connection} [customConnection]
 * @returns {Promise<{ username: string, role: string, uri: string }>}
 */
async function setupAuditAppUser(customConnection) {
  const conn = customConnection || mongoose.connection;
  const db = conn.db;
  const dbName = db.databaseName;

  // 1. Create or update custom role with find + insert privileges only
  try {
    await db.command({
      createRole: AUDIT_APP_USER_CONFIG.role,
      privileges: [
        {
          resource: { db: dbName, collection: 'auditevents' },
          actions: ['insert', 'find'],
        },
      ],
      roles: [],
    });
  } catch (err) {
    if (err.code === 8000 || err.codeName === 'AtlasError' || (err.message && (err.message.includes('CMD_NOT_ALLOWED') || err.message.includes('not allowed')))) {
      console.log('[Audit] Managed database detected (MongoDB Atlas). Cloud IAM manages roles; application schema enforces audit immutability.');
      return {
        username: AUDIT_APP_USER_CONFIG.username,
        role: AUDIT_APP_USER_CONFIG.role,
        uri: conn._connectionString || '',
      };
    }
    if (err.codeName === 'RoleAlreadyExists' || (err.message && err.message.includes('already exists'))) {
      await db.command({
        updateRole: AUDIT_APP_USER_CONFIG.role,
        privileges: [
          {
            resource: { db: dbName, collection: 'auditevents' },
            actions: ['insert', 'find'],
          },
        ],
        roles: [],
      });
    } else {
      throw err;
    }
  }

  // 2. Create or update user bound to the custom role
  try {
    await db.command({
      createUser: AUDIT_APP_USER_CONFIG.username,
      pwd: AUDIT_APP_USER_CONFIG.password,
      roles: [
        { role: AUDIT_APP_USER_CONFIG.role, db: dbName },
      ],
    });
  } catch (err) {
    if (err.codeName === 'UserAlreadyExists' || (err.message && err.message.includes('already exists'))) {
      await db.command({
        updateUser: AUDIT_APP_USER_CONFIG.username,
        pwd: AUDIT_APP_USER_CONFIG.password,
        roles: [
          { role: AUDIT_APP_USER_CONFIG.role, db: dbName },
        ],
      });
    } else {
      throw err;
    }
  }

  const host = conn.host || '127.0.0.1';
  const port = conn.port || 27017;
  const uri = `mongodb://${AUDIT_APP_USER_CONFIG.username}:${encodeURIComponent(AUDIT_APP_USER_CONFIG.password)}@${host}:${port}/${dbName}?authSource=${dbName}`;

  return {
    username: AUDIT_APP_USER_CONFIG.username,
    role: AUDIT_APP_USER_CONFIG.role,
    uri,
  };
}

module.exports = {
  logAuditEvent,
  verifyChain,
  setupAuditAppUser,
  canonicalizeContent,
  calculateHash,
  GENESIS_PREVIOUS_HASH,
  AUDIT_APP_USER_CONFIG,
};
