const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const FileType = require('file-type');
const { User } = require('../models');
const { logAuditEvent } = require('../audit');
const documentService = require('../services/documentService');

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
async function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await User.findById(req.session.userId);
    if (!user || user.isActive === false) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Upload request handler
 */
async function handleUpload(req, res, next) {
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

      // Save document record through documentService (Rule 2: Routes never query documents directly)
      const document = await documentService.createDocument({
        user: req.user,
        name: req.body.name || req.body.title || path.parse(originalName).name || 'Untitled Document',
        title: req.body.title || req.body.name || path.parse(originalName).name || 'Untitled Document',
        description: req.body.description || '',
        category: req.body.category || 'general',
        tags: Array.isArray(req.body.tags)
          ? req.body.tags
          : typeof req.body.tags === 'string'
            ? req.body.tags.split(',').map((t) => t.trim()).filter(Boolean)
            : [],
        fileStorageName,
        originalFileName: originalName,
        mimeType: detected.mime,
        sizeBytes: req.file.size,
        sha256,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.status(201).json({
        message: 'Document uploaded successfully',
        document: document.toJSON(),
      });
    } catch (error) {
      next(error);
    }
  });
}

/**
 * @route   GET /documents (also mounted at /api/documents)
 * @desc    List all documents accessible to the requesting user (Rule 6: permission-filtered in DB)
 * @access  Authenticated
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const documents = await documentService.listDocuments(req.user, req.query);
    res.status(200).json({
      count: documents.length,
      total: documents.length,
      resultCount: documents.length,
      documents: documents.map((doc) => doc.toJSON()),
      results: documents.map((doc) => doc.toJSON()),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /documents/search (also mounted at /api/documents/search)
 * @desc    Search documents accessible to requesting user (Rule 6: permission-filtered in DB)
 * @access  Authenticated
 */
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const documents = await documentService.searchDocuments(req.user, req.query);
    res.status(200).json({
      count: documents.length,
      total: documents.length,
      resultCount: documents.length,
      documents: documents.map((doc) => doc.toJSON()),
      results: documents.map((doc) => doc.toJSON()),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /documents/:id
 * @desc    Get document details by ID through authorize()
 * @access  Authenticated (authorized via authorize() in documentService)
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await documentService.getDocumentById(req.user, req.params.id, 'read');
    res.status(200).json({
      document: doc.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /documents/upload
 * @desc    Upload document with magic byte inspection, path traversal sanitization, UUID storage & SHA-256
 * @access  Authenticated
 */
router.post('/upload', requireAuth, handleUpload);

/**
 * @route   POST /documents
 * @desc    Alias for upload
 */
router.post('/', requireAuth, handleUpload);

/**
 * @route   GET /documents/:id/download
 * @desc    Stream document through application with Content-Disposition: attachment
 * @access  Authenticated (authorized via authorize() in documentService)
 */
router.get('/:id/download', requireAuth, async (req, res, next) => {
  try {
    const { document, stream } = await documentService.getDownloadStream(
      req.user,
      req.params.id,
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );

    // Stream through the app with Content-Disposition: attachment
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(document.originalFileName)}"`
    );
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Length', document.sizeBytes);

    stream.pipe(res);
    stream.on('error', (streamErr) => next(streamErr));
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /documents/:id
 * @desc    Edit document metadata (title and description) through authorize()
 * @access  Authenticated (authorized via authorize() in documentService)
 */
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const updatedDoc = await documentService.updateDocumentMetadata(
      req.user,
      req.params.id,
      {
        name: req.body.name,
        title: req.body.title,
        description: req.body.description,
        category: req.body.category,
        tags: req.body.tags,
      },
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );

    res.status(200).json({
      message: 'Document metadata updated successfully',
      document: updatedDoc.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /documents/:id
 * @desc    Alias for updating document metadata
 */
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const updatedDoc = await documentService.updateDocumentMetadata(
      req.user,
      req.params.id,
      {
        name: req.body.name,
        title: req.body.title,
        description: req.body.description,
        category: req.body.category,
        tags: req.body.tags,
      },
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );

    res.status(200).json({
      message: 'Document metadata updated successfully',
      document: updatedDoc.toJSON(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /documents/:id
 * @desc    Delete document, physical storage file, and associated permissions through authorize()
 * @access  Authenticated (authorized via authorize() in documentService - owner only)
 */
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await documentService.deleteDocument(
      req.user,
      req.params.id,
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /documents/:id/permissions
 * @desc    Grant or update document permissions (owner only via authorize())
 * @access  Authenticated (authorized via authorize() in documentService)
 */
router.post('/:id/permissions', requireAuth, async (req, res, next) => {
  try {
    const result = await documentService.grantPermission(
      req.user,
      req.params.id,
      req.body,
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /documents/:id/grant
 * @desc    Alias for granting permissions
 */
router.post('/:id/grant', requireAuth, async (req, res, next) => {
  try {
    const result = await documentService.grantPermission(
      req.user,
      req.params.id,
      req.body,
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /documents/:id/permissions/:userId
 * @desc    Revoke document permission for a user (owner only via authorize())
 * @access  Authenticated (authorized via authorize() in documentService)
 */
router.delete('/:id/permissions/:userId', requireAuth, async (req, res, next) => {
  try {
    const result = await documentService.revokePermission(
      req.user,
      req.params.id,
      req.params.userId,
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /documents/:id/revoke
 * @desc    Alternative alias for revoking document permissions
 */
router.post('/:id/revoke', requireAuth, async (req, res, next) => {
  try {
    const targetUserId = req.body?.userId || req.query?.userId;
    const result = await documentService.revokePermission(
      req.user,
      req.params.id,
      targetUserId,
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /documents/:id/replace
 * @desc    Replace a document's physical file with a new file, recording old and new SHA-256
 * @access  Authenticated (authorized via authorize() in documentService)
 */
async function handleFileReplace(req, res, next) {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        await logAuditEvent({
          eventType: 'UPLOAD_FAILED',
          userId: req.session.userId,
          action: 'replace',
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
        action: 'replace',
        status: 'DENIED',
        reason: err.message,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(400).json({ error: err.message });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      await logAuditEvent({
        eventType: 'UPLOAD_FAILED',
        userId: req.session.userId,
        action: 'replace',
        status: 'DENIED',
        reason: 'Empty or missing file provided for replacement',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
      return res.status(400).json({ error: 'No file provided or file is empty' });
    }

    const originalName = req.file.originalname || '';
    if (originalName.includes('..') || originalName.includes('/') || originalName.includes('\\')) {
      await logAuditEvent({
        eventType: 'UPLOAD_FAILED',
        userId: req.session.userId,
        action: 'replace',
        status: 'DENIED',
        reason: 'Path traversal sequence detected in filename',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        metadata: { attemptedFilename: originalName },
      });
      return res.status(400).json({ error: 'Invalid filename' });
    }

    try {
      const detected = await FileType.fromBuffer(req.file.buffer);
      if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime)) {
        await logAuditEvent({
          eventType: 'UPLOAD_FAILED',
          userId: req.session.userId,
          action: 'replace',
          status: 'DENIED',
          reason: `File type not allowed or unrecognized: ${detected ? detected.mime : 'unknown'}`,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
        });
        return res.status(400).json({ error: 'File type not allowed' });
      }

      const updatedDoc = await documentService.replaceDocumentFile(
        req.user,
        req.params.id,
        {
          fileBuffer: req.file.buffer,
          originalFileName: originalName,
          mimeType: detected.mime,
          size: req.file.size,
        },
        { ipAddress: req.ip, userAgent: req.get('User-Agent') }
      );

      res.status(200).json({
        message: 'File replaced successfully',
        document: updatedDoc.toJSON(),
      });
    } catch (error) {
      next(error);
    }
  });
}

router.post('/:id/replace', requireAuth, handleFileReplace);
router.put('/:id/replace', requireAuth, handleFileReplace);
router.post('/:id/file', requireAuth, handleFileReplace);
router.put('/:id/file', requireAuth, handleFileReplace);

/**
 * @route   DELETE /documents/:id/permissions
 * @desc    Alternative body/query-based revocation endpoint
 */
router.delete('/:id/permissions', requireAuth, async (req, res, next) => {
  try {
    const targetUserId = req.body?.userId || req.query?.userId;
    const result = await documentService.revokePermission(
      req.user,
      req.params.id,
      targetUserId,
      { ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;


