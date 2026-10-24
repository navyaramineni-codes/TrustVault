const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { AuditEvent, User, Document, Permission } = require('../src/models');
const { logAuditEvent, verifyChain, setupAuditAppUser } = require('../src/audit');
const documentService = require('../src/services/documentService');
const { seedDatabase } = require('../scripts/seed');

describe('Audit Subsystem - Cryptographic Hash Chaining, verifyChain, and Least Privilege', () => {
  let adminCookie;
  let ownerCookie;
  let viewerCookie;
  let adminUser;
  let ownerUser;
  let viewerUser;

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    // Fetch seeded users
    adminUser = await User.findOne({ email: 'admin@trustvault.local' });
    ownerUser = await User.findOne({ email: 'owner@trustvault.local' });
    viewerUser = await User.findOne({ email: 'viewer@trustvault.local' });

    // Authenticate admin
    const adminLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@trustvault.local', password: 'AdminVault2026!' });
    adminCookie = adminLogin.headers['set-cookie'];

    // Authenticate owner
    const ownerLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@trustvault.local', password: 'OwnerVault2026!' });
    ownerCookie = ownerLogin.headers['set-cookie'];

    // Authenticate viewer
    const viewerLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'viewer@trustvault.local', password: 'ViewerVault2026!' });
    viewerCookie = viewerLogin.headers['set-cookie'];
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // =========================================================================
  // 1. CRYPTOGRAPHIC HASH CHAIN & SEQUENCE NUMBER
  // =========================================================================
  describe('Cryptographic Hash Chaining & Linear Sequencing', () => {
    beforeEach(async () => {
      // Clear audit events before chain unit tests
      await AuditEvent.collection.deleteMany({});
    });

    it('should create a genesis event with sequence 1, 64-zero previousHash, and valid SHA-256 hash', async () => {
      const genesis = await logAuditEvent({
        eventType: 'SYSTEM_GENESIS',
        action: 'initialize',
        status: 'SUCCESS',
        metadata: { info: 'Genesis block' },
      });

      expect(genesis).toBeDefined();
      expect(genesis.sequenceNumber).toBe(1);
      expect(genesis.previousHash).toBe('0'.repeat(64));
      expect(genesis.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should chain subsequent events with incrementing sequence numbers and previousHash matching prior event hash', async () => {
      const event1 = await logAuditEvent({
        eventType: 'AUTH_LOGIN',
        action: 'login',
        status: 'SUCCESS',
      });

      const event2 = await logAuditEvent({
        eventType: 'DOCUMENT_UPLOAD',
        action: 'upload',
        status: 'SUCCESS',
      });

      const event3 = await logAuditEvent({
        eventType: 'DOCUMENT_DOWNLOAD',
        action: 'read',
        status: 'SUCCESS',
      });

      expect(event1.sequenceNumber).toBe(1);
      expect(event1.previousHash).toBe('0'.repeat(64));

      expect(event2.sequenceNumber).toBe(2);
      expect(event2.previousHash).toBe(event1.hash);

      expect(event3.sequenceNumber).toBe(3);
      expect(event3.previousHash).toBe(event2.hash);
    });

    it('should verify a valid untampered audit chain using verifyChain()', async () => {
      await logAuditEvent({ eventType: 'TEST_1', action: 'action_1', status: 'SUCCESS' });
      await logAuditEvent({ eventType: 'TEST_2', action: 'action_2', status: 'SUCCESS' });
      await logAuditEvent({ eventType: 'TEST_3', action: 'action_3', status: 'DENIED' });

      const result = await verifyChain();
      expect(result.valid).toBe(true);
      expect(result.count).toBe(3);
    });
  });

  // =========================================================================
  // 2. TAMPER DETECTION: verifyChain() FAILS WHEN ROWS ARE ALTERED
  // =========================================================================
  describe('Tamper Detection & Verification Failures', () => {
    beforeEach(async () => {
      await AuditEvent.collection.deleteMany({});
      await logAuditEvent({ eventType: 'EVENT_1', action: 'read', status: 'SUCCESS', reason: 'Normal' });
      await logAuditEvent({ eventType: 'EVENT_2', action: 'edit', status: 'SUCCESS', reason: 'Normal' });
      await logAuditEvent({ eventType: 'EVENT_3', action: 'delete', status: 'DENIED', reason: 'Denied' });
    });

    it('should make verifyChain() fail when a row content is altered in the database', async () => {
      // Confirm chain is initially valid
      const initialCheck = await verifyChain();
      expect(initialCheck.valid).toBe(true);

      // Bypass Mongoose pre-hooks by updating directly at MongoDB collection level
      await AuditEvent.collection.updateOne(
        { sequenceNumber: 2 },
        { $set: { status: 'DENIED', reason: 'Malicious modification' } }
      );

      const tamperedCheck = await verifyChain();
      expect(tamperedCheck.valid).toBe(false);
      expect(tamperedCheck.sequenceNumber).toBe(2);
      expect(tamperedCheck.error).toMatch(/tampered|mismatch|hash/i);
    });

    it('should make verifyChain() fail when a previousHash pointer is modified', async () => {
      const bogusHash = 'a'.repeat(64);
      await AuditEvent.collection.updateOne(
        { sequenceNumber: 3 },
        { $set: { previousHash: bogusHash } }
      );

      const check = await verifyChain();
      expect(check.valid).toBe(false);
      expect(check.sequenceNumber).toBe(3);
      expect(check.error).toMatch(/pointer|previousHash/i);
    });

    it('should make verifyChain() fail when a hash is modified', async () => {
      const bogusHash = 'b'.repeat(64);
      await AuditEvent.collection.updateOne(
        { sequenceNumber: 1 },
        { $set: { hash: bogusHash } }
      );

      const check = await verifyChain();
      expect(check.valid).toBe(false);
      expect(check.sequenceNumber).toBe(1);
    });

    it('should make verifyChain() fail if an event is deleted creating a sequence gap', async () => {
      await AuditEvent.collection.deleteOne({ sequenceNumber: 2 });

      const check = await verifyChain();
      expect(check.valid).toBe(false);
      expect(check.error).toMatch(/gap|sequence/i);
    });
  });

  // =========================================================================
  // 3. CONCURRENCY & FORK PREVENTION
  // =========================================================================
  describe('Concurrency & Fork Prevention', () => {
    beforeEach(async () => {
      await AuditEvent.collection.deleteMany({});
    });

    it('should prevent forks and assign contiguous sequence numbers under concurrent writes', async () => {
      const numConcurrent = 10;
      const promises = [];

      for (let i = 0; i < numConcurrent; i++) {
        promises.push(
          logAuditEvent({
            eventType: 'CONCURRENT_WRITE',
            action: `action_${i}`,
            status: 'SUCCESS',
            metadata: { index: i },
          })
        );
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(numConcurrent);

      // Verify sequence numbers are unique and contiguous 1..10
      const sequences = results.map((r) => r.sequenceNumber).sort((a, b) => a - b);
      expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Verify entire chain is cryptographically intact with no forks
      const check = await verifyChain();
      expect(check.valid).toBe(true);
      expect(check.count).toBe(numConcurrent);
    });
  });

  // =========================================================================
  // 4. MONGODB APP USER LEAST PRIVILEGE: INSERT AND FIND ONLY
  // =========================================================================
  describe('MongoDB App User Least Privilege (Insert & Find Only)', () => {
    let appUserUri;
    let appConnection;

    beforeAll(async () => {
      const userConfig = await setupAuditAppUser(mongoose.connection);
      appUserUri = userConfig.uri;
    });

    afterAll(async () => {
      if (appConnection) {
        await appConnection.close();
      }
    });

    it('should prove the app user can insert an audit row', async () => {
      appConnection = await mongoose.createConnection(appUserUri).asPromise();
      const auditColl = appConnection.collection('auditevents');

      const insertResult = await auditColl.insertOne({
        sequenceNumber: 999901,
        eventType: 'APP_USER_TEST',
        action: 'insert_test',
        status: 'SUCCESS',
        previousHash: '0'.repeat(64),
        hash: 'c'.repeat(64),
        timestamp: new Date(),
      });

      expect(insertResult.acknowledged).toBe(true);
      expect(insertResult.insertedId).toBeDefined();
    });

    it('should prove the app user can find audit rows', async () => {
      const auditColl = appConnection.collection('auditevents');
      const found = await auditColl.findOne({ sequenceNumber: 999901 });

      expect(found).toBeDefined();
      expect(found.action).toBe('insert_test');
    });

    it('should prove the app user CANNOT update audit rows (rejected at MongoDB engine level)', async () => {
      const auditColl = appConnection.collection('auditevents');

      await expect(
        auditColl.updateOne(
          { sequenceNumber: 999901 },
          { $set: { action: 'tampered_by_app_user' } }
        )
      ).rejects.toThrow(/not authorized/i);
    });

    it('should prove the app user CANNOT delete audit rows (rejected at MongoDB engine level)', async () => {
      const auditColl = appConnection.collection('auditevents');

      await expect(
        auditColl.deleteOne({ sequenceNumber: 999901 })
      ).rejects.toThrow(/not authorized/i);

      // Clean up the test row using admin connection
      await AuditEvent.collection.deleteOne({ sequenceNumber: 999901 });
    });
  });

  // =========================================================================
  // 5. EVENT LOGGING COVERAGE ACROSS APPLICATION
  // =========================================================================
  describe('Application Event Logging Completeness', () => {
    let testDocId;
    let originalSha256;

    beforeEach(async () => {
      await AuditEvent.collection.deleteMany({});
    });

    it('should log upload event with sha256 and metadata', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 sample content for audit upload test');
      const expectedSha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

      const res = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'audit_upload.pdf')
        .field('title', 'Audit Upload Title');

      expect(res.status).toBe(201);
      testDocId = res.body.document._id;
      originalSha256 = expectedSha256;

      const uploadEvent = await AuditEvent.findOne({
        eventType: { $in: ['DOCUMENT_CREATE', 'DOCUMENT_UPLOAD'] },
        documentId: testDocId,
      });

      expect(uploadEvent).toBeDefined();
      expect(uploadEvent.status).toBe('SUCCESS');
      expect(uploadEvent.metadata.sha256).toBe(expectedSha256);
    });

    it('should log download event', async () => {
      // First upload a doc
      const pdfBuffer = Buffer.from('%PDF-1.4 sample content for download test');
      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'download_test.pdf');
      const docId = uploadRes.body.document._id;

      await AuditEvent.collection.deleteMany({});

      const downloadRes = await request(app)
        .get(`/documents/${docId}/download`)
        .set('Cookie', ownerCookie);

      expect(downloadRes.status).toBe(200);

      const downloadEvent = await AuditEvent.findOne({
        eventType: 'DOCUMENT_DOWNLOAD',
        documentId: docId,
      });

      expect(downloadEvent).toBeDefined();
      expect(downloadEvent.action).toBe('read');
      expect(downloadEvent.status).toBe('SUCCESS');
    });

    it('should log metadata edit event', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 sample content for edit test');
      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'edit_test.pdf');
      const docId = uploadRes.body.document._id;

      await AuditEvent.collection.deleteMany({});

      const editRes = await request(app)
        .patch(`/documents/${docId}`)
        .set('Cookie', ownerCookie)
        .send({ title: 'New Updated Title', description: 'Updated Desc' });

      expect(editRes.status).toBe(200);

      const editEvent = await AuditEvent.findOne({
        eventType: 'DOCUMENT_UPDATE',
        documentId: docId,
      });

      expect(editEvent).toBeDefined();
      expect(editEvent.action).toBe('edit');
      expect(editEvent.status).toBe('SUCCESS');
      expect(editEvent.metadata.newTitle).toBe('New Updated Title');
    });

    it('should log file replacement with old and new SHA-256', async () => {
      // 1. Initial file
      const initialBuffer = Buffer.from('%PDF-1.4 initial content for replacement test');
      const oldSha256 = crypto.createHash('sha256').update(initialBuffer).digest('hex');

      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', initialBuffer, 'original.pdf');
      const docId = uploadRes.body.document._id;

      await AuditEvent.collection.deleteMany({});

      // 2. Replacement file
      const replacementBuffer = Buffer.from('%PDF-1.4 replaced newer binary content');
      const newSha256 = crypto.createHash('sha256').update(replacementBuffer).digest('hex');

      const replaceRes = await request(app)
        .post(`/documents/${docId}/replace`)
        .set('Cookie', ownerCookie)
        .attach('file', replacementBuffer, 'replacement.pdf');

      expect(replaceRes.status).toBe(200);

      const replaceEvent = await AuditEvent.findOne({
        eventType: { $in: ['FILE_REPLACE', 'DOCUMENT_REPLACE'] },
        documentId: docId,
      });

      expect(replaceEvent).toBeDefined();
      expect(replaceEvent.status).toBe('SUCCESS');
      expect(replaceEvent.metadata.oldSha256).toBe(oldSha256);
      expect(replaceEvent.metadata.newSha256).toBe(newSha256);
    });

    it('should log document delete event', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 sample content for delete test');
      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'delete_test.pdf');
      const docId = uploadRes.body.document._id;

      await AuditEvent.collection.deleteMany({});

      const deleteRes = await request(app)
        .delete(`/documents/${docId}`)
        .set('Cookie', ownerCookie);

      expect(deleteRes.status).toBe(200);

      const deleteEvent = await AuditEvent.findOne({
        eventType: 'DOCUMENT_DELETE',
        documentId: docId,
      });

      expect(deleteEvent).toBeDefined();
      expect(deleteEvent.action).toBe('delete');
      expect(deleteEvent.status).toBe('SUCCESS');
    });

    it('should log permission grant event', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 sample content for grant test');
      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'grant_test.pdf');
      const docId = uploadRes.body.document._id;

      await AuditEvent.collection.deleteMany({});

      const grantRes = await request(app)
        .post(`/documents/${docId}/permissions`)
        .set('Cookie', ownerCookie)
        .send({ userId: viewerUser._id.toString(), level: 'read' });

      expect(grantRes.status).toBe(200);

      const grantEvent = await AuditEvent.findOne({
        eventType: 'PERMISSION_GRANT',
        documentId: docId,
      });

      expect(grantEvent).toBeDefined();
      expect(grantEvent.action).toBe('grant');
      expect(grantEvent.status).toBe('SUCCESS');
      expect(grantEvent.metadata.level).toBe('read');
    });

    it('should log permission revoke event', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 sample content for revoke test');
      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'revoke_test.pdf');
      const docId = uploadRes.body.document._id;

      await documentService.grantPermission(ownerUser, docId, {
        userId: viewerUser._id,
        level: 'read',
      });

      await AuditEvent.collection.deleteMany({});

      const revokeRes = await request(app)
        .delete(`/documents/${docId}/permissions/${viewerUser._id}`)
        .set('Cookie', ownerCookie);

      expect(revokeRes.status).toBe(200);

      const revokeEvent = await AuditEvent.findOne({
        eventType: 'PERMISSION_REVOKE',
        documentId: docId,
      });

      expect(revokeEvent).toBeDefined();
      expect(revokeEvent.status).toBe('SUCCESS');
    });

    it('should log user create event in admin routes', async () => {
      const newEmail = `audit-newuser-${Date.now()}@trustvault.local`;

      const createRes = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: newEmail,
          password: 'Password123!',
          role: 'user',
        });

      expect(createRes.status).toBe(201);

      const createEvent = await AuditEvent.findOne({
        eventType: { $in: ['USER_CREATE', 'USER_CREATED'] },
        'metadata.createdEmail': newEmail,
      });

      expect(createEvent).toBeDefined();
      expect(createEvent.status).toBe('SUCCESS');
    });

    it('should log role change event in admin routes', async () => {
      const userToPromote = await User.create({
        email: `promote-${Date.now()}@trustvault.local`,
        passwordHash: 'dummy',
        role: 'user',
      });

      const roleRes = await request(app)
        .patch(`/admin/users/${userToPromote._id}/role`)
        .set('Cookie', adminCookie)
        .send({ role: 'admin' });

      expect(roleRes.status).toBe(200);

      const roleEvent = await AuditEvent.findOne({
        eventType: { $in: ['ROLE_CHANGE', 'USER_ROLE_CHANGE'] },
        'metadata.targetUserId': userToPromote._id,
      });

      expect(roleEvent).toBeDefined();
      expect(roleEvent.status).toBe('SUCCESS');
      expect(roleEvent.metadata.newRole).toBe('admin');
    });

    it('should log user disable event in admin routes', async () => {
      const userToDisable = await User.create({
        email: `disable-${Date.now()}@trustvault.local`,
        passwordHash: 'dummy',
        role: 'user',
        isActive: true,
      });

      const disableRes = await request(app)
        .post(`/admin/users/${userToDisable._id}/disable`)
        .set('Cookie', adminCookie);

      expect(disableRes.status).toBe(200);

      const disableEvent = await AuditEvent.findOne({
        eventType: { $in: ['USER_DISABLE', 'USER_DISABLED'] },
        'metadata.targetUserId': userToDisable._id,
      });

      expect(disableEvent).toBeDefined();
      expect(disableEvent.status).toBe('SUCCESS');
    });

    it('should log every denied attempt (unauthorized document access, non-admin access, bad uploads)', async () => {
      // 1. Unauthorized document access (Rule 3)
      const pdfBuffer = Buffer.from('%PDF-1.4 secret document content');
      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'secret.pdf');
      const secretDocId = uploadRes.body.document._id;

      await AuditEvent.collection.deleteMany({});

      const deniedReadRes = await request(app)
        .get(`/documents/${secretDocId}`)
        .set('Cookie', viewerCookie); // viewer has not been granted access

      expect(deniedReadRes.status).toBe(404);

      const deniedReadEvent = await AuditEvent.findOne({
        eventType: 'ACCESS_DENIED',
        status: 'DENIED',
        documentId: secretDocId,
      });
      expect(deniedReadEvent).toBeDefined();

      // 2. Non-admin accessing admin route
      const deniedAdminRes = await request(app)
        .post('/admin/users')
        .set('Cookie', viewerCookie)
        .send({ email: 'hacker@vault.local', password: '123' });

      expect(deniedAdminRes.status).toBe(404);

      const deniedAdminEvent = await AuditEvent.findOne({
        eventType: 'ACCESS_DENIED',
        status: 'DENIED',
        action: 'admin_access',
      });
      expect(deniedAdminEvent).toBeDefined();

      // 3. Bad upload (e.g. empty file)
      const badUploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', Buffer.alloc(0), 'empty.pdf');

      expect(badUploadRes.status).toBe(400);

      const badUploadEvent = await AuditEvent.findOne({
        eventType: 'UPLOAD_FAILED',
        status: 'DENIED',
      });
      expect(badUploadEvent).toBeDefined();
    });

    it('should verify that all logged actions form an unbroken valid cryptographic chain', async () => {
      // Execute a real workflow of application events
      const pdfBuffer = Buffer.from('%PDF-1.4 chained action test workflow');
      const uploadRes = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', pdfBuffer, 'chain_workflow.pdf');
      const docId = uploadRes.body.document._id;

      await request(app).get(`/documents/${docId}/download`).set('Cookie', ownerCookie);
      await request(app).patch(`/documents/${docId}`).set('Cookie', ownerCookie).send({ title: 'New Chained Title' });
      await request(app).post(`/documents/${docId}/permissions`).set('Cookie', ownerCookie).send({ userId: viewerUser._id.toString(), level: 'read' });
      await request(app).delete(`/documents/${docId}/permissions/${viewerUser._id}`).set('Cookie', ownerCookie);
      await request(app).delete(`/documents/${docId}`).set('Cookie', ownerCookie);

      const chainCheck = await verifyChain();
      expect(chainCheck.valid).toBe(true);
      expect(chainCheck.count).toBeGreaterThanOrEqual(6);
    });

  });
});
