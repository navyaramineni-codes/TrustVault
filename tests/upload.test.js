const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { Document, AuditEvent } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');

describe('Document Upload Security & 5 Bad Uploads Tests', () => {
  let sessionCookie;
  let ownerUser;

  const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage', 'documents');

  // Minimal valid PDF binary buffer (recognized by file-type)
  const VALID_PDF_BUFFER = Buffer.from(
    '%PDF-1.5\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000102 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n'
  );

  // Executable binary buffer (Windows PE header 'MZ')
  const EXE_BUFFER = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00');

  // Bash shell script buffer
  const SCRIPT_BUFFER = Buffer.from('#!/bin/bash\necho "Malicious Script Execution"\n');

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    // Authenticate as owner to obtain session cookie
    const loginRes = await request(app)
      .post('/auth/login')
      .send({
        email: 'owner@trustvault.local',
        password: 'OwnerVault2026!',
      });

    expect(loginRes.status).toBe(200);
    sessionCookie = loginRes.headers['set-cookie'];
    ownerUser = loginRes.body.user;
  });

  afterAll(async () => {
    try {
      // Clean up test documents created in DB
      await Document.deleteMany({ ownerId: ownerUser._id, title: /Test Upload/i });
    } finally {
      await disconnectDB();
    }
  });

  // =========================================================================
  // 5 BAD UPLOADS SPECIFICATION TESTS
  // =========================================================================

  describe('5 Bad Uploads Rejection Tests', () => {
    // 1. Wrong type
    it('1. Wrong type: should reject non-whitelisted file type (e.g. bash script / executable) with 400', async () => {
      const response = await request(app)
        .post('/documents/upload')
        .set('Cookie', sessionCookie)
        .attach('file', SCRIPT_BUFFER, 'malicious.sh')
        .field('title', 'Test Upload - Malicious Script');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/type|allowed/i);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'UPLOAD_FAILED',
        userId: ownerUser._id,
        reason: /type|allowed/i,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    // 2. Spoofed extension
    it('2. Spoofed extension: should reject executable payload disguised as PDF via magic byte inspection with 400', async () => {
      // Named legitimate 'statement.pdf' but contains binary executable 'MZ' bytes
      const response = await request(app)
        .post('/documents/upload')
        .set('Cookie', sessionCookie)
        .attach('file', EXE_BUFFER, 'statement.pdf')
        .field('title', 'Test Upload - Spoofed PDF');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/type|spoof|match/i);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'UPLOAD_FAILED',
        userId: ownerUser._id,
        reason: /type|spoof|match/i,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    // 3. Oversized file
    it('3. Oversized file: should reject files exceeding size limit (>5MB) with 400 or 413', async () => {
      // Generate a 5.5 MB dummy buffer exceeding standard 5MB limit
      const OVERSIZED_BUFFER = Buffer.alloc(5.5 * 1024 * 1024, 0x41);

      const response = await request(app)
        .post('/documents/upload')
        .set('Cookie', sessionCookie)
        .attach('file', OVERSIZED_BUFFER, 'huge_document.pdf')
        .field('title', 'Test Upload - Oversized');

      expect([400, 413]).toContain(response.status);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/size|large|limit/i);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'UPLOAD_FAILED',
        userId: ownerUser._id,
        reason: /size|large|limit/i,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    // 4. Path traversal (../ in filename)
    it('4. ../ filename: should reject path traversal sequences in filename with 400', async () => {
      const response = await request(app)
        .post('/documents/upload')
        .set('Cookie', sessionCookie)
        .attach('file', VALID_PDF_BUFFER, {
          filename: '../../../../etc/cron.d/evil.pdf',
          filepath: '../../../../etc/cron.d/evil.pdf',
        })
        .field('title', 'Test Upload - Path Traversal Attempt');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/traversal|filename|invalid/i);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'UPLOAD_FAILED',
        userId: ownerUser._id,
        reason: /traversal|filename/i,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    // 5. Empty file (0 bytes)
    it('5. Empty file: should reject zero-byte uploads with 400', async () => {
      const EMPTY_BUFFER = Buffer.alloc(0);

      const response = await request(app)
        .post('/documents/upload')
        .set('Cookie', sessionCookie)
        .attach('file', EMPTY_BUFFER, 'empty.pdf')
        .field('title', 'Test Upload - Empty File');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/empty|size/i);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'UPLOAD_FAILED',
        userId: ownerUser._id,
        reason: /empty/i,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });
  });

  // =========================================================================
  // HAPPY PATH: VALID UPLOAD WITH UUID STORAGE & SHA-256 RECORDING
  // =========================================================================

  describe('Valid Upload, UUID Storage & Cryptographic Verification', () => {
    let uploadedDocId;
    let storageFileName;

    afterEach(async () => {
      // Clean up uploaded file from disk if created
      if (storageFileName) {
        const filePath = path.join(STORAGE_DIR, storageFileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });

    it('should successfully upload valid PDF, store under UUID, record SHA-256, and write audit event', async () => {
      const expectedSha256 = crypto
        .createHash('sha256')
        .update(VALID_PDF_BUFFER)
        .digest('hex');

      const response = await request(app)
        .post('/documents/upload')
        .set('Cookie', sessionCookie)
        .attach('file', VALID_PDF_BUFFER, 'Quarterly_Report_2026.pdf')
        .field('title', 'Test Upload - Quarterly Financial Report')
        .field('description', 'Official verified financial summary');

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('message', 'Document uploaded successfully');
      expect(response.body).toHaveProperty('document');

      const doc = response.body.document;
      uploadedDocId = doc._id;
      storageFileName = doc.fileStorageName;

      // 1. Verify UUID storage format (UUID v4)
      expect(doc.fileStorageName).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      // 2. Verify metadata properties
      expect(doc.originalFileName).toBe('Quarterly_Report_2026.pdf');
      expect(doc.mimeType).toBe('application/pdf');
      expect(doc.sizeBytes).toBe(VALID_PDF_BUFFER.length);
      expect(doc.ownerId).toBe(ownerUser._id);

      // 3. Verify SHA-256 recording
      expect(doc.sha256).toBe(expectedSha256);

      // 4. Verify physical disk file exists outside web root under UUID
      const onDiskPath = path.join(STORAGE_DIR, doc.fileStorageName);
      expect(fs.existsSync(onDiskPath)).toBe(true);

      const diskBytes = fs.readFileSync(onDiskPath);
      expect(diskBytes.length).toBe(VALID_PDF_BUFFER.length);
      const diskSha256 = crypto.createHash('sha256').update(diskBytes).digest('hex');
      expect(diskSha256).toBe(expectedSha256);

      // 5. Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'DOCUMENT_CREATE',
        documentId: doc._id,
        userId: ownerUser._id,
      });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('SUCCESS');
      expect(auditLog.action).toBe('create');
    });

    it('should reject unauthenticated upload requests with 401', async () => {
      const response = await request(app)
        .post('/documents/upload')
        .attach('file', VALID_PDF_BUFFER, 'unauth_report.pdf')
        .field('title', 'Unauthenticated Attempt');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
  });
});
