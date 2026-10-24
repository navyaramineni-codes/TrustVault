const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User, Document, Permission, AuditEvent } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');
const { logAuditEvent, verifyChain } = require('../src/audit');

describe('Admin Activity Feed, Permission History & verifyChain Specification', () => {
  let adminCookie;
  let userCookie;
  let adminUser;
  let standardUser;
  let viewerUser;
  let sampleDoc1;
  let sampleDoc2;

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    adminUser = await User.findOne({ email: 'admin@trustvault.local' });
    standardUser = await User.findOne({ email: 'owner@trustvault.local' });
    viewerUser = await User.findOne({ email: 'viewer@trustvault.local' });

    // Login as admin
    const adminLoginRes = await request(app)
      .post('/auth/login')
      .send({
        email: 'admin@trustvault.local',
        password: 'AdminVault2026!',
      });
    adminCookie = adminLoginRes.headers['set-cookie'];

    // Login as standard user (non-admin)
    const userLoginRes = await request(app)
      .post('/auth/login')
      .send({
        email: 'owner@trustvault.local',
        password: 'OwnerVault2026!',
      });
    userCookie = userLoginRes.headers['set-cookie'];

    // Clean up test documents from prior runs
    await Document.deleteMany({ name: /q3_earnings|internal_security_audit/i });

    // Create test documents for activity and permission tests
    const uuid1 = crypto.randomUUID();
    const uuid2 = crypto.randomUUID();
    const sha1 = crypto.createHash('sha256').update('doc_content_1').digest('hex');
    const sha2 = crypto.createHash('sha256').update('doc_content_2').digest('hex');

    sampleDoc1 = await Document.create({
      name: 'q3_earnings_confidential.pdf',
      title: 'Q3 Financial Earnings Report',
      category: 'finance',
      tags: ['financial', 'q3'],
      storagePath: uuid1,
      fileStorageName: uuid1,
      mimeType: 'application/pdf',
      size: 4096,
      sizeBytes: 4096,
      sha256: sha1,
      owner: standardUser._id,
      ownerId: standardUser._id,
      deletedAt: null,
    });

    sampleDoc2 = await Document.create({
      name: 'internal_security_audit_spec.pdf',
      title: 'Internal Security Architecture Audit',
      category: 'security',
      tags: ['security', 'audit'],
      storagePath: uuid2,
      fileStorageName: uuid2,
      mimeType: 'application/pdf',
      size: 8192,
      sizeBytes: 8192,
      sha256: sha2,
      owner: standardUser._id,
      ownerId: standardUser._id,
      deletedAt: null,
    });

    // Generate distinct activity events for testing filters
    // 1. Upload event
    await logAuditEvent({
      eventType: 'DOCUMENT_CREATE',
      userId: standardUser._id,
      documentId: sampleDoc1._id,
      action: 'create',
      status: 'SUCCESS',
      metadata: {
        name: sampleDoc1.name,
        category: sampleDoc1.category,
        sizeBytes: sampleDoc1.sizeBytes,
        sha256: sampleDoc1.sha256,
      },
    });

    // 2. Permission grant event
    await logAuditEvent({
      eventType: 'PERMISSION_GRANT',
      userId: standardUser._id,
      documentId: sampleDoc1._id,
      action: 'grant_permission',
      status: 'SUCCESS',
      metadata: {
        level: 'read',
        targetUserId: viewerUser._id.toString(),
        targetEmail: viewerUser.email,
        documentName: sampleDoc1.name,
      },
    });

    // 3. Permission revoke event
    await logAuditEvent({
      eventType: 'PERMISSION_REVOKE',
      userId: standardUser._id,
      documentId: sampleDoc1._id,
      action: 'revoke_permission',
      status: 'SUCCESS',
      metadata: {
        targetUserId: viewerUser._id.toString(),
        targetEmail: viewerUser.email,
        documentName: sampleDoc1.name,
      },
    });

    // 4. Access denied event for viewer on sampleDoc2
    await logAuditEvent({
      eventType: 'ACCESS_DENIED',
      userId: viewerUser._id,
      documentId: sampleDoc2._id,
      action: 'read',
      status: 'DENIED',
      reason: 'Unauthorized document access attempt',
      metadata: {
        attemptedAction: 'read',
        documentName: sampleDoc2.name,
      },
    });
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // =========================================================================
  // 1. ACCESS CONTROL: Non-admins get 404 (Rule 3)
  // =========================================================================
  describe('Access Control & Anti-Enumeration (Non-Admins Get 404)', () => {
    it('should return 404 for unauthenticated requests to the admin page', async () => {
      const res = await request(app).get('/admin');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for non-admin users accessing the admin page', async () => {
      const res = await request(app)
        .get('/admin')
        .set('Cookie', userCookie);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for unauthenticated requests to admin activity API', async () => {
      const res = await request(app).get('/admin/activity');
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-admin users requesting admin activity API', async () => {
      const res = await request(app)
        .get('/admin/activity')
        .set('Cookie', userCookie);
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-admin users attempting verifyChain()', async () => {
      const res = await request(app)
        .post('/admin/verify-chain')
        .set('Cookie', userCookie);
      expect(res.status).toBe(404);
    });

    it('should allow admin user to access the admin page (200 OK with HTML)', async () => {
      const res = await request(app)
        .get('/admin')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
    });
  });

  // =========================================================================
  // 2. METADATA-ONLY ENFORCEMENT: Never file contents or download links
  // =========================================================================
  describe('Metadata-Only Guarantee (No File Contents or Download Links)', () => {
    it('should never include file contents, storagePath, or download links in activity feed', async () => {
      const res = await request(app)
        .get('/admin/activity')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        // Assert absence of file content fields
        expect(event).not.toHaveProperty('fileContent');
        expect(event).not.toHaveProperty('content');
        expect(event).not.toHaveProperty('fileBuffer');
        expect(event).not.toHaveProperty('storagePath');

        // Assert absence of download links
        const jsonStr = JSON.stringify(event);
        expect(jsonStr).not.toContain('/download');
        expect(jsonStr).not.toContain('downloadUrl');
        expect(jsonStr).not.toContain('downloadLink');

        // Confirm metadata presence
        expect(event).toHaveProperty('sequenceNumber');
        expect(event).toHaveProperty('eventType');
        expect(event).toHaveProperty('action');
        expect(event).toHaveProperty('status');
        expect(event).toHaveProperty('hash');
        expect(event).toHaveProperty('timestamp');
      }
    });

    it('should never include download links or file content viewers in the admin page HTML', async () => {
      const res = await request(app)
        .get('/admin')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const html = res.text;

      // Ensure no download routes or download anchors exist in the admin HTML
      expect(html).not.toContain('/download');
      expect(html).not.toContain('download="');
      expect(html).not.toContain('download=');
      // Confirms metadata labeling exists
      expect(html).toContain('Activity Feed');
      expect(html).toContain('Permission');
      expect(html).toContain('verifyChain');
    });
  });

  // =========================================================================
  // 3. ACTIVITY FEED & FILTERING
  // =========================================================================
  describe('Activity Feed & Multi-Criteria Filtering', () => {
    it('should filter activity feed by user email', async () => {
      const res = await request(app)
        .get(`/admin/activity?user=${viewerUser.email}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      // All returned events should reference viewerUser
      for (const event of events) {
        const matchesUser =
          (event.userId && event.userId.toString() === viewerUser._id.toString()) ||
          (event.userEmail && event.userEmail.toLowerCase() === viewerUser.email.toLowerCase()) ||
          (event.metadata && (
            event.metadata.targetUserId === viewerUser._id.toString() ||
            event.metadata.targetEmail === viewerUser.email
          ));
        expect(matchesUser).toBe(true);
      }
    });

    it('should filter activity feed by user ObjectId', async () => {
      const res = await request(app)
        .get(`/admin/activity?user=${standardUser._id.toString()}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        const matchesUser =
          (event.userId && event.userId.toString() === standardUser._id.toString()) ||
          (event.metadata && event.metadata.targetUserId === standardUser._id.toString());
        expect(matchesUser).toBe(true);
      }
    });

    it('should filter activity feed by document ID', async () => {
      const res = await request(app)
        .get(`/admin/activity?document=${sampleDoc1._id.toString()}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        expect(event.documentId.toString()).toBe(sampleDoc1._id.toString());
      }
    });

    it('should filter activity feed by document name keyword', async () => {
      const res = await request(app)
        .get('/admin/activity?document=q3_earnings')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        const matchesDocId = Boolean(event.documentId && event.documentId.toString() === sampleDoc1._id.toString());
        const matchesDocName = Boolean(event.documentName && event.documentName.includes('q3_earnings'));
        const matchesMetaDoc = Boolean(event.metadata && (
          (event.metadata.documentName && event.metadata.documentName.includes('q3_earnings')) ||
          (event.metadata.name && event.metadata.name.includes('q3_earnings'))
        ));
        expect(matchesDocId || matchesDocName || matchesMetaDoc).toBe(true);
      }
    });

    it('should filter activity feed by date range', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const res = await request(app)
        .get(`/admin/activity?startDate=${pastDate}&endDate=${futureDate}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(events.length).toBeGreaterThan(0);

      const pastMs = new Date(pastDate).getTime();
      const futureMs = new Date(futureDate).getTime();

      for (const event of events) {
        const eventMs = new Date(event.timestamp).getTime();
        expect(eventMs).toBeGreaterThanOrEqual(pastMs);
        expect(eventMs).toBeLessThanOrEqual(futureMs);
      }
    });
  });

  // =========================================================================
  // 4. PERMISSION-CHANGE HISTORY
  // =========================================================================
  describe('Permission-Change History View', () => {
    it('should return permission-change history containing only grant and revoke events', async () => {
      const res = await request(app)
        .get('/admin/permissions/history')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        expect(['PERMISSION_GRANT', 'PERMISSION_REVOKE']).toContain(event.eventType);
        expect(event).toHaveProperty('sequenceNumber');
        expect(event).toHaveProperty('hash');
        expect(event).toHaveProperty('timestamp');
        // Ensure metadata includes target user / document details
        expect(event).toHaveProperty('metadata');
      }
    });

    it('should filter permission history by target user', async () => {
      const res = await request(app)
        .get(`/admin/permissions/history?user=${viewerUser.email}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const events = res.body.events || res.body.data;
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        expect(['PERMISSION_GRANT', 'PERMISSION_REVOKE']).toContain(event.eventType);
        const targetEmail = event.metadata && (event.metadata.targetEmail || event.metadata.email);
        const targetId = event.metadata && (event.metadata.targetUserId || event.metadata.userId);
        const matchesViewer =
          targetEmail === viewerUser.email ||
          targetId === viewerUser._id.toString() ||
          event.userId === viewerUser._id.toString();
        expect(matchesViewer).toBe(true);
      }
    });
  });

  // =========================================================================
  // 5. BUTTON & ENDPOINT THAT RUNS verifyChain()
  // =========================================================================
  describe('Audit Chain Verification Endpoint (verifyChain)', () => {
    it('should run verifyChain() and return valid status for intact audit chain', async () => {
      const res = await request(app)
        .post('/admin/verify-chain')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('isValid', true);
      expect(res.body).toHaveProperty('totalEvents');
      expect(typeof res.body.totalEvents).toBe('number');
      expect(res.body.totalEvents).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('verifiedAt');
      expect(res.body.brokenSequence).toBeNull();
    });

    it('should support GET /admin/verify-chain as idempotent query', async () => {
      const res = await request(app)
        .get('/admin/verify-chain')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('isValid', true);
    });

    it('should detect altered row and report brokenSequence when chain is tampered', async () => {
      // Find latest audit event and tamper with its hash directly in database
      const latestEvent = await AuditEvent.findOne().sort({ sequenceNumber: -1 });
      expect(latestEvent).not.toBeNull();

      const originalHash = latestEvent.hash;
      const tamperedHash = crypto.createHash('sha256').update('tampered_content_injection').digest('hex');

      // Temporarily tamper with the hash via native collection to simulate external DB tampering
      await mongoose.connection.collection('auditevents').updateOne(
        { _id: latestEvent._id },
        { $set: { hash: tamperedHash } }
      );

      const verifyRes = await request(app)
        .post('/admin/verify-chain')
        .set('Cookie', adminCookie);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body).toHaveProperty('isValid', false);
      expect(verifyRes.body.brokenSequence).toBe(latestEvent.sequenceNumber);
      expect(verifyRes.body).toHaveProperty('error');

      // Restore original hash to leave database clean for subsequent tests
      await mongoose.connection.collection('auditevents').updateOne(
        { _id: latestEvent._id },
        { $set: { hash: originalHash } }
      );

      // Confirm chain is restored
      const restoreCheck = await request(app)
        .post('/admin/verify-chain')
        .set('Cookie', adminCookie);
      expect(restoreCheck.body.isValid).toBe(true);
    });
  });
});
