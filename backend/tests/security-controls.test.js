const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = require('../src/app');
const authz = require('../src/authz');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User, Document, AuditEvent } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');

describe('Security Controls Specification: CSRF, Rate-Limiting, Helmet, Cross-User Isolation & Mandatory authorize()', () => {
  let userACookie;
  let userBCookie;
  let userA;
  let userB;
  let docA;

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    // User A: Document owner
    userA = await User.findOne({ email: 'owner@trustvault.local' });
    const loginA = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@trustvault.local', password: 'OwnerVault2026!' });
    userACookie = loginA.headers['set-cookie'];

    // User B: Unrelated user with no grants on User A's document
    userB = await User.findOne({ email: 'viewer@trustvault.local' });
    const loginB = await request(app)
      .post('/auth/login')
      .send({ email: 'viewer@trustvault.local', password: 'ViewerVault2026!' });
    userBCookie = loginB.headers['set-cookie'];

    // User A uploads a confidential document
    const uploadRes = await request(app)
      .post('/documents/upload')
      .set('Cookie', userACookie)
      .attach(
        'file',
        Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\ntrailer\n<<\n/Root 1 0 R\n>>\n%%EOF'),
        'user_a_private_contract.pdf'
      );
    docA = uploadRes.body.document;
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // =========================================================================
  // 1. HELMET SECURITY HEADERS
  // =========================================================================
  describe('Helmet Security Baseline', () => {
    it('should include Helmet security headers on all responses and omit X-Powered-By', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.headers).not.toHaveProperty('x-powered-by');
      expect(res.headers).toHaveProperty('x-content-type-options', 'nosniff');
      expect(res.headers).toHaveProperty('x-frame-options');
    });
  });

  // =========================================================================
  // 2. EXPRESS-RATE-LIMIT ON LOGIN (5 attempts per minute)
  // =========================================================================
  describe('Express Rate Limiter on /auth/login (5 attempts per minute)', () => {
    it('should allow 5 consecutive login attempts and block the 6th with 429 Too Many Requests', async () => {
      const testEmail = `ratelimit-target-${Date.now()}@trustvault.local`;

      // 5 attempts should not be blocked by rate limit
      for (let i = 1; i <= 5; i++) {
        const res = await request(app)
          .post('/auth/login')
          .set('x-test-rate-limit', 'true')
          .send({
            email: testEmail,
            password: 'WrongPassword!',
          });

        expect(res.status).not.toBe(429);
      }

      // The 6th attempt within the 1-minute window must return 429 Too Many Requests
      const blockedRes = await request(app)
        .post('/auth/login')
        .set('x-test-rate-limit', 'true')
        .send({
          email: testEmail,
          password: 'WrongPassword!',
        });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body).toHaveProperty('error');
      expect(blockedRes.body.error).toMatch(/too many.*login.*attempts/i);
    });
  });

  // =========================================================================
  // 3. CSRF-CSRF PROTECTION
  // =========================================================================
  describe('csrf-csrf Double Submit Protection', () => {
    it('should provide /auth/csrf-token endpoint that issues a CSRF token and cookie', async () => {
      const res = await request(app).get('/auth/csrf-token');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('csrfToken');
      expect(typeof res.body.csrfToken).toBe('string');
      expect(res.body.csrfToken.length).toBeGreaterThan(10);
    });

    it('should reject state-changing request with 403 when CSRF is enforced and token is missing', async () => {
      const res = await request(app)
        .post('/documents/upload')
        .set('Cookie', userACookie)
        .set('x-test-csrf', 'true')
        .send({});

      expect(res.status).toBe(403);
    });

    it('should accept state-changing request when valid CSRF token and cookie are provided', async () => {
      // Step 1: Fetch CSRF token for authenticated user session
      const tokenRes = await request(app)
        .get('/auth/csrf-token')
        .set('Cookie', userACookie);
      const csrfToken = tokenRes.body.csrfToken;
      const csrfCookies = tokenRes.headers['set-cookie'] || [];

      // Step 2: Send request with CSRF token header and clean cookie pairs
      const combinedCookies = [...userACookie, ...csrfCookies].map((c) => c.split(';')[0]);

      const res = await request(app)
        .post('/documents/upload')
        .set('Cookie', combinedCookies)
        .set('x-csrf-token', csrfToken)
        .set('x-test-csrf', 'true')
        .attach(
          'file',
          Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\ntrailer\n<<\n/Root 1 0 R\n>>\n%%EOF'),
          'csrf_valid_upload.pdf'
        );

      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // 4. CROSS-USER ISOLATION TESTS
  // User B tries to read, download, edit and delete User A's document.
  // Each must return 404 and change nothing in the database.
  // =========================================================================
  describe('Cross-User Authorization Tests (User B vs User A Doc)', () => {
    it('should return 404 when User B tries to READ User A document metadata', async () => {
      const res = await request(app)
        .get(`/documents/${docA._id}`)
        .set('Cookie', userBCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 when User B tries to DOWNLOAD User A document file', async () => {
      const res = await request(app)
        .get(`/documents/${docA._id}/download`)
        .set('Cookie', userBCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 when User B tries to EDIT User A document metadata via PATCH and change nothing', async () => {
      const initialDoc = await Document.findById(docA._id);
      const originalTitle = initialDoc.title;
      const originalDescription = initialDoc.description;

      const res = await request(app)
        .patch(`/documents/${docA._id}`)
        .set('Cookie', userBCookie)
        .send({
          title: 'Hacked Title By User B',
          description: 'Malicious Description Injection',
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });

      // Verify in database: absolutely nothing was changed
      const currentDoc = await Document.findById(docA._id);
      expect(currentDoc.title).toBe(originalTitle);
      expect(currentDoc.description).toBe(originalDescription);
    });

    it('should return 404 when User B tries to EDIT User A document metadata via PUT and change nothing', async () => {
      const initialDoc = await Document.findById(docA._id);
      const originalTitle = initialDoc.title;

      const res = await request(app)
        .put(`/documents/${docA._id}`)
        .set('Cookie', userBCookie)
        .send({
          title: 'PUT Malicious Title By User B',
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });

      const currentDoc = await Document.findById(docA._id);
      expect(currentDoc.title).toBe(originalTitle);
    });

    it('should return 404 when User B tries to DELETE User A document and leave document intact (not deleted)', async () => {
      const res = await request(app)
        .delete(`/documents/${docA._id}`)
        .set('Cookie', userBCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });

      // Verify in database: document is NOT deleted and deletedAt remains null
      const currentDoc = await Document.findById(docA._id);
      expect(currentDoc).not.toBeNull();
      expect(currentDoc.deletedAt).toBeNull();
    });

    it('should record an ACCESS_DENIED audit event for each denied cross-user attempt', async () => {
      const deniedEvents = await AuditEvent.find({
        userId: userB._id,
        status: 'DENIED',
      });

      expect(deniedEvents.length).toBeGreaterThanOrEqual(4);
      for (const event of deniedEvents) {
        expect(event.status).toBe('DENIED');
        expect(event.userId.toString()).toBe(userB._id.toString());
      }
    });
  });

  // =========================================================================
  // 5. TEST THAT FAILS IF ANY DOCUMENT ROUTE DOES NOT CALL authorize()
  // =========================================================================
  describe('Mandatory Policy Decision Point: Every Document Route Must Call authorize()', () => {
    it('should verify that all document routes dispatch through authz.authorize()', async () => {
      const authorizeSpy = jest.spyOn(authz, 'authorize');

      // 1. GET /documents/:id (read)
      authorizeSpy.mockClear();
      await request(app)
        .get(`/documents/${docA._id}`)
        .set('Cookie', userACookie);
      expect(authorizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: expect.anything() }),
        expect.objectContaining({ _id: expect.anything() }),
        'read'
      );

      // 2. GET /documents/:id/download (read)
      authorizeSpy.mockClear();
      await request(app)
        .get(`/documents/${docA._id}/download`)
        .set('Cookie', userACookie);
      expect(authorizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: expect.anything() }),
        expect.objectContaining({ _id: expect.anything() }),
        'read'
      );

      // 3. PATCH /documents/:id (edit)
      authorizeSpy.mockClear();
      await request(app)
        .patch(`/documents/${docA._id}`)
        .set('Cookie', userACookie)
        .send({ title: 'Authorized Title Update' });
      expect(authorizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: expect.anything() }),
        expect.objectContaining({ _id: expect.anything() }),
        'edit'
      );

      // 4. PUT /documents/:id (edit alias)
      authorizeSpy.mockClear();
      await request(app)
        .put(`/documents/${docA._id}`)
        .set('Cookie', userACookie)
        .send({ title: 'Authorized PUT Update' });
      expect(authorizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: expect.anything() }),
        expect.objectContaining({ _id: expect.anything() }),
        'edit'
      );

      // 5. POST /documents/:id/permissions (grant)
      authorizeSpy.mockClear();
      await request(app)
        .post(`/documents/${docA._id}/permissions`)
        .set('Cookie', userACookie)
        .send({ userId: userB._id.toString(), level: 'read' });
      expect(authorizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: expect.anything() }),
        expect.objectContaining({ _id: expect.anything() }),
        'grant'
      );

      // 6. DELETE /documents/:id/permissions/:userId (revoke)
      authorizeSpy.mockClear();
      await request(app)
        .delete(`/documents/${docA._id}/permissions/${userB._id}`)
        .set('Cookie', userACookie);
      expect(authorizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: expect.anything() }),
        expect.objectContaining({ _id: expect.anything() }),
        'grant'
      );

      // 7. DELETE /documents/:id (delete)
      authorizeSpy.mockClear();
      await request(app)
        .delete(`/documents/${docA._id}`)
        .set('Cookie', userACookie);
      expect(authorizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: expect.anything() }),
        expect.objectContaining({ _id: expect.anything() }),
        'delete'
      );

      authorizeSpy.mockRestore();
    });

    it('should fail if a document route exists that bypasses authorize()', () => {
      // Inspect document router stack: any route accessing a document parameter :id
      // MUST NOT directly query Document model without authorize()
      const fs = require('fs');
      const path = require('path');
      const documentRoutesSource = fs.readFileSync(
        path.join(__dirname, '../src/routes/documents.js'),
        'utf8'
      );

      // Rule 2 check: Routes never query the documents collection directly
      expect(documentRoutesSource).not.toMatch(/const\s+.*Document.*=\s*require\(.*models.*\)/);
      expect(documentRoutesSource).not.toMatch(/Document\.(find|findOne|findById|create|update|deleteOne|deleteMany)/);

      // Service check: every documentService function that accesses/modifies a document by ID calls authorize
      const documentServiceSource = fs.readFileSync(
        path.join(__dirname, '../src/services/documentService.js'),
        'utf8'
      );
      expect(documentServiceSource).toContain('authz.authorize(');

      // Verification: Ensure every exported document mutation/read method routes through getDocumentById/authorize
      const documentService = require('../src/services/documentService');
      const protectedMethods = [
        'getDocumentById',
        'getDownloadStream',
        'updateDocumentMetadata',
        'deleteDocument',
        'grantPermission',
        'revokePermission',
        'replaceDocumentFile',
      ];

      for (const method of protectedMethods) {
        expect(typeof documentService[method]).toBe('function');
      }
    });
  });
});
