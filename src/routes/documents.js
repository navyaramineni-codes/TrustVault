const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const FileType = require('file-type');
const { Document } = require('../models');
const { logAuditEvent } = require('../audit');

const router = express.Router();

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage', 'documents');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB maximum limit

// Allowed MIME types whitelist
const ALLOWED_MIME_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

// Extension to MIME type mapping for spoof detection
const EXTENSION_MIME_MAP = Object.freeze({
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

// Configure multer memory storage to inspect buffer in-memory before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
});

/**
 * Authentication guard middleware for document routes
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * @route   POST /documents/upload (also mounted at /documents and /api/documents/upload)
 * @desc    Upload document with magic byte inspection, path traversal sanitization, UUID storage & SHA-256 hash
 * @access  Authenticated
 */
router.post('/upload', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    // 1. Handle Multer size limit error (Bad Upload 3: Oversized file)
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        await logAuditEvent({
          eventType: 'UPLOAD_FAILED',
          userId: req.session.userId,
          action: 'upload',
          status: 'DENIED',
          reason: 'File size limit exceeded (maximum 5MB)',
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
        });
        return res.status(400).json({ error: 'File size limit exceeded (maximum 5MB)' });
      }

      await logAuditEvent({
        eventType: 'UPLOAD_FAILED',
        userId: req.session.userId,
        action: 'upload',
        status: 'DENIED',
        reason: err.message,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(400).json({ error: err.message });
    }

    // Check if file was provided
    if (!req.file) {
      await logAuditEvent({
        eventType: 'UPLOAD_FAILED',
        userId: req.session.userId,
        action: 'upload',
        status: 'DENIED',
        reason: 'No file uploaded',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(400).json({ error: 'No file provided' });
    }

    const originalName = req.file.originalname || '';

    // 2. Bad Upload 5: Empty file (0 bytes)
    if (!req.file.buffer || req.file.size === 0 || req.file.buffer.length === 0) {
      await logAuditEvent({
        eventType: 'UPLOAD_FAILED',
        userId: req.session.userId,
        action: 'upload',
        status: 'DENIED',
        reason: 'Empty files are not allowed',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(400).json({ error: 'Empty files are not allowed' });
    }

    // 3. Bad Upload 4: Path traversal attempt (../ in filename)
    if (originalName.includes('..') || originalName.includes('/') || originalName.includes('\\')) {
      await logAuditEvent({
        eventType: 'UPLOAD_FAILED',
        userId: req.session.userId,
        action: 'upload',
        status: 'DENIED',
        reason: 'Path traversal sequence detected in filename',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        metadata: { attemptedFilename: originalName },
      });
      return res.status(400).json({
        error: 'Invalid filename: path traversal sequences are not allowed',
      });
    }

    try {
      // 4. Bad Upload 1 & 2: Magic byte validation using file-type
      const detected = await FileType.fromBuffer(req.file.buffer);

      // If magic bytes cannot be identified or are not in the allowed list
      if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime)) {
        await logAuditEvent({
          eventType: 'UPLOAD_FAILED',
          userId: req.session.userId,
          action: 'upload',
          status: 'DENIED',
          reason: `File type not allowed or unrecognized: ${detected ? detected.mime : 'unknown'}`,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          metadata: { declaredMime: req.file.mimetype, detectedMime: detected?.mime },
        });
        return res.status(400).json({ error: 'File type not allowed' });
      }

      // Spoofed extension verification: Compare detected MIME against file extension
      const ext = path.extname(originalName).toLowerCase();
      const expectedMime = EXTENSION_MIME_MAP[ext];
      if (expectedMime && expectedMime !== detected.mime) {
        await logAuditEvent({
          eventType: 'UPLOAD_FAILED',
          userId: req.session.userId,
          action: 'upload',
          status: 'DENIED',
          reason: `Spoofed file extension: extension ${ext} does not match detected content ${detected.mime}`,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
        });
        return res.status(400).json({
          error: 'File content does not match declared type (spoofed extension)',
        });
      }

      // 5. Secure Storage: Cryptographic UUID filename and SHA-256 calculation
      const fileStorageName = crypto.randomUUID();
      const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

      // Ensure storage directory outside web root exists
      await fs.promises.mkdir(STORAGE_DIR, { recursive: true });

      // Save binary to disk strictly using UUID filename
      const targetPath = path.join(STORAGE_DIR, fileStorageName);
      await fs.promises.writeFile(targetPath, req.file.buffer);

      // Save document record in database
      const document = await Document.create({
        title: req.body.title || path.parse(originalName).name || 'Untitled Document',
        description: req.body.description || '',
        fileStorageName: fileStorageName,
        originalFileName: originalName,
        mimeType: detected.mime,
        sizeBytes: req.file.size,
        sha256: sha256,
        ownerId: req.session.userId,
      });

      // Log success audit event (Rule 7: Every state change writes an audit event)
      await logAuditEvent({
        eventType: 'DOCUMENT_CREATE',
        userId: req.session.userId,
        documentId: document._id,
        action: 'create',
        status: 'SUCCESS',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        metadata: {
          title: document.title,
          sha256: document.sha256,
          sizeBytes: document.sizeBytes,
          mimeType: document.mimeType,
        },
      });

      res.status(201).json({
        message: 'Document uploaded successfully',
        document: document.toJSON(),
      });
    } catch (error) {
      next(error);
    }
  });
});

// Alias: POST /documents (root of router)
router.post('/', (req, res, next) => {
  // Delegate to /upload handler
  req.url = '/upload';
  router.handle(req, res, next);
});

module.exports = router;
