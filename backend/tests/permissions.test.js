const request = require('supertest');
const mongoose = require('mongoose');
const path = require('path');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User, Document, Permission } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');

describe('Document Permissions Management (Grant, Read, Revoke, Boundary Tests)', () => {
  let ownerUser;
  let viewerUser;
  let adminUser;
  let otherUser;

  let ownerCookie;
  let viewerCookie;
  let adminCookie;
  let otherCookie;

  let ownerDoc;

  const SAMPLE_PDF_BUFFER = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n165\n%%EOF'
  );

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    ownerUser = await User.findOne({ email: 'owner@trustvault.local' });
    viewerUser = await User.findOne({ email: 'viewer@trustvault.local' });
    adminUser = await User.findOne({ email: 'admin@trustvault.local' });

    // Create a 4th user for multi-party permission tests
    const passHash = await require('@node-rs/argon2').hash('OtherPass2026!');
    otherUser = await User.findOneAndUpdate(
      { email: 'other@trustvault.local' },
      { email: 'other@trustvault.local', passwordHash: passHash, role: 'user', isActive: true },
      { upsert: true, new: true }
    );

    // Login owner
    const ownerRes = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@trustvault.local', password: 'OwnerVault2026!' });
    ownerCookie = ownerRes.headers['set-cookie'];

    // Login viewer
    const viewerRes = await request(app)
      .post('/auth/login')
      .send({ email: 'viewer@trustvault.local', password: 'ViewerVault2026!' });
    viewerCookie = viewerRes.headers['set-cookie'];

    // Login admin
    const adminRes = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@trustvault.local', password: 'AdminVault2026!' });
    adminCookie = adminRes.headers['set-cookie'];

    // Login other user
    const otherRes = await request(app)
      .post('/auth/login')
      .send({ email: 'other@trustvault.local', password: 'OtherPass2026!' });
    otherCookie = otherRes.headers['set-cookie'];
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    // Create fresh document uploaded by owner for each test
    const uploadRes = await request(app)
      .post('/documents/upload')
      .set('Cookie', ownerCookie)
      .attach('file', SAMPLE_PDF_BUFFER, `grant_test_${Date.now()}.pdf`)
      .field('title', 'Permissions Grant Test Doc');

    ownerDoc = uploadRes.body.document;

    // Clean up permissions on this doc
    await Permission.deleteMany({ documentId: ownerDoc._id });
  });

  // =========================================================================
  // 1. LIFECYCLE: Grant read -> Viewer reads -> Owner revokes -> Viewer gets 404
  // =========================================================================
  describe('Permission Lifecycle: Grant Read -> Read -> Revoke -> 404', () => {
    it('should allow owner to grant read to viewer, viewer reads, owner revokes, and viewer next request returns 404', async () => {
      // Step 1: Viewer initially has no permission, so read returns 404
      const initialRead = await request(app)
        .get(`/documents/${ownerDoc._id}/download`)
        .set('Cookie', viewerCookie);
      expect(initialRead.status).toBe(404);
      expect(initialRead.body).toEqual({ error: 'Not Found' });

      // Step 2: Owner grants read permission to viewer
      const grantRes = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({
          userId: viewerUser._id.toString(),
          level: 'read',
        });

      expect(grantRes.status).toBe(200);
      expect(grantRes.body).toHaveProperty('message', 'Permission granted successfully');
      expect(grantRes.body).toHaveProperty('permission');
      expect(grantRes.body.permission.level).toBe('read');
      expect(grantRes.body.permission.userId.toString()).toBe(viewerUser._id.toString());

      // Verify in MongoDB
      const dbPerm = await Permission.findOne({
        documentId: ownerDoc._id,
        userId: viewerUser._id,
      });
      expect(dbPerm).not.toBeNull();
      expect(dbPerm.level).toBe('read');

      // Step 3: Viewer reads the document successfully
      const viewerReadRes = await request(app)
        .get(`/documents/${ownerDoc._id}/download`)
        .set('Cookie', viewerCookie);
      expect(viewerReadRes.status).toBe(200);
      expect(viewerReadRes.headers['content-disposition']).toMatch(/attachment;/i);

      // Also verify metadata read via GET /documents/:id
      const viewerMetaRes = await request(app)
        .get(`/documents/${ownerDoc._id}`)
        .set('Cookie', viewerCookie);
      expect(viewerMetaRes.status).toBe(200);
      expect(viewerMetaRes.body.document._id.toString()).toBe(ownerDoc._id.toString());

      // Step 4: Owner revokes the permission
      const revokeRes = await request(app)
        .delete(`/documents/${ownerDoc._id}/permissions/${viewerUser._id}`)
        .set('Cookie', ownerCookie);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body).toHaveProperty('message', 'Permission revoked successfully');

      // Verify removed from MongoDB
      const dbPermAfter = await Permission.findOne({
        documentId: ownerDoc._id,
        userId: viewerUser._id,
      });
      expect(dbPermAfter).toBeNull();

      // Step 5: Viewer next request immediately returns 404 (with no caching delay)
      const nextReadRes = await request(app)
        .get(`/documents/${ownerDoc._id}/download`)
        .set('Cookie', viewerCookie);
      expect(nextReadRes.status).toBe(404);
      expect(nextReadRes.body).toEqual({ error: 'Not Found' });

      const nextMetaRes = await request(app)
        .get(`/documents/${ownerDoc._id}`)
        .set('Cookie', viewerCookie);
      expect(nextMetaRes.status).toBe(404);
      expect(nextMetaRes.body).toEqual({ error: 'Not Found' });

      // Step 6: Omitted from viewer document list
      const listRes = await request(app)
        .get('/documents')
        .set('Cookie', viewerCookie);
      const listIds = listRes.body.documents.map((d) => d._id.toString());
      expect(listIds).not.toContain(ownerDoc._id.toString());
    });
  });

  // =========================================================================
  // 2. PRIVILEGE BOUNDARIES: Read grant CANNOT edit
  // =========================================================================
  describe('Privilege Boundary: Read Grant Cannot Edit', () => {
    beforeEach(async () => {
      // Grant read to viewer
      await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({
          userId: viewerUser._id.toString(),
          level: 'read',
        });
    });

    it('should reject edit attempts via PATCH /documents/:id with 404 for viewer with read grant', async () => {
      const editRes = await request(app)
        .patch(`/documents/${ownerDoc._id}`)
        .set('Cookie', viewerCookie)
        .send({ title: 'Tampered Title by Read Viewer' });

      expect(editRes.status).toBe(404);
      expect(editRes.body).toEqual({ error: 'Not Found' });

      // Verify title remained unchanged in DB
      const dbDoc = await Document.findById(ownerDoc._id);
      expect(dbDoc.title).not.toBe('Tampered Title by Read Viewer');
    });

    it('should reject edit attempts via PUT /documents/:id with 404 for viewer with read grant', async () => {
      const editRes = await request(app)
        .put(`/documents/${ownerDoc._id}`)
        .set('Cookie', viewerCookie)
        .send({ title: 'Tampered Title by Read Viewer via PUT' });

      expect(editRes.status).toBe(404);
      expect(editRes.body).toEqual({ error: 'Not Found' });
    });
  });

  // =========================================================================
  // 3. PRIVILEGE BOUNDARIES: Edit grant CAN edit, but CANNOT delete or grant
  // =========================================================================
  describe('Privilege Boundary: Edit Grant Can Edit but Cannot Delete or Grant', () => {
    beforeEach(async () => {
      // Owner grants edit to viewer
      await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({
          userId: viewerUser._id.toString(),
          level: 'edit',
        });
    });

    it('should allow viewer with edit grant to edit metadata', async () => {
      const editRes = await request(app)
        .patch(`/documents/${ownerDoc._id}`)
        .set('Cookie', viewerCookie)
        .send({
          title: 'Legitimate Edit by Viewer',
          description: 'Updated by authorized editor',
        });

      expect(editRes.status).toBe(200);
      expect(editRes.body.document.title).toBe('Legitimate Edit by Viewer');

      // Verify updated in DB
      const dbDoc = await Document.findById(ownerDoc._id);
      expect(dbDoc.title).toBe('Legitimate Edit by Viewer');
    });

    it('should deny viewer with edit grant from deleting the document with 404 (Rule 4 & 5)', async () => {
      const deleteRes = await request(app)
        .delete(`/documents/${ownerDoc._id}`)
        .set('Cookie', viewerCookie);

      expect(deleteRes.status).toBe(404);
      expect(deleteRes.body).toEqual({ error: 'Not Found' });

      // Verify document still exists in DB
      const dbDoc = await Document.findById(ownerDoc._id);
      expect(dbDoc).not.toBeNull();
      expect(dbDoc.deletedAt).toBeNull();
    });

    it('should deny viewer with edit grant from granting permissions to other users with 404', async () => {
      const grantRes = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', viewerCookie)
        .send({
          userId: otherUser._id.toString(),
          level: 'read',
        });

      expect(grantRes.status).toBe(404);
      expect(grantRes.body).toEqual({ error: 'Not Found' });

      // Verify no permission created for otherUser
      const dbPerm = await Permission.findOne({
        documentId: ownerDoc._id,
        userId: otherUser._id,
      });
      expect(dbPerm).toBeNull();
    });

    it('should deny viewer with edit grant from revoking permissions with 404', async () => {
      // Create a permission for otherUser directly
      await Permission.create({
        documentId: ownerDoc._id,
        userId: otherUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });

      const revokeRes = await request(app)
        .delete(`/documents/${ownerDoc._id}/permissions/${otherUser._id}`)
        .set('Cookie', viewerCookie);

      expect(revokeRes.status).toBe(404);
      expect(revokeRes.body).toEqual({ error: 'Not Found' });

      // Verify permission was NOT revoked
      const dbPerm = await Permission.findOne({
        documentId: ownerDoc._id,
        userId: otherUser._id,
      });
      expect(dbPerm).not.toBeNull();
    });
  });

  // =========================================================================
  // 4. OWNERSHIP EXCLUSIVITY: Only the owner can grant or revoke
  // =========================================================================
  describe('Ownership Exclusivity: Only Owner Can Grant or Revoke', () => {
    it('should return 404 when viewer attempts to grant permissions on unowned document', async () => {
      const res = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', viewerCookie)
        .send({
          userId: otherUser._id.toString(),
          level: 'read',
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 when viewer attempts to revoke permissions on unowned document', async () => {
      const res = await request(app)
        .delete(`/documents/${ownerDoc._id}/permissions/${otherUser._id}`)
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 when admin attempts to grant permissions without document ownership (Rule 4)', async () => {
      const res = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', adminCookie)
        .send({
          userId: viewerUser._id.toString(),
          level: 'read',
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 when admin attempts to revoke permissions without document ownership (Rule 4)', async () => {
      const res = await request(app)
        .delete(`/documents/${ownerDoc._id}/permissions/${viewerUser._id}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 401 when unauthenticated request attempts to grant or revoke', async () => {
      const grantRes = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .send({ userId: viewerUser._id.toString(), level: 'read' });
      expect(grantRes.status).toBe(401);

      const revokeRes = await request(app)
        .delete(`/documents/${ownerDoc._id}/permissions/${viewerUser._id}`);
      expect(revokeRes.status).toBe(401);
    });
  });

  // =========================================================================
  // 5. INPUT VALIDATION & IDEMPOTENCY
  // =========================================================================
  describe('Input Validation & Idempotency', () => {
    it('should reject invalid permission level (e.g. "delete" or "admin") with 400', async () => {
      const resDelete = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({
          userId: viewerUser._id.toString(),
          level: 'delete',
        });
      expect(resDelete.status).toBe(400);

      const resAdmin = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({
          userId: viewerUser._id.toString(),
          level: 'admin',
        });
      expect(resAdmin.status).toBe(400);
    });

    it('should return 404 when granting to a non-existent user ID', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({
          userId: fakeId.toString(),
          level: 'read',
        });
      expect(res.status).toBe(404);
    });

    it('should allow re-granting to update permission level from read to edit idempotently', async () => {
      // Grant read
      await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({ userId: viewerUser._id.toString(), level: 'read' });

      // Re-grant edit
      const updateRes = await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({ userId: viewerUser._id.toString(), level: 'edit' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.permission.level).toBe('edit');

      // Verify in DB only 1 record exists with level edit
      const perms = await Permission.find({
        documentId: ownerDoc._id,
        userId: viewerUser._id,
      });
      expect(perms).toHaveLength(1);
      expect(perms[0].level).toBe('edit');
    });

    it('should support alternative POST /documents/:id/revoke route parity', async () => {
      // Grant read
      await request(app)
        .post(`/documents/${ownerDoc._id}/permissions`)
        .set('Cookie', ownerCookie)
        .send({ userId: viewerUser._id.toString(), level: 'read' });

      // Revoke using POST /documents/:id/revoke
      const revokeRes = await request(app)
        .post(`/documents/${ownerDoc._id}/revoke`)
        .set('Cookie', ownerCookie)
        .send({ userId: viewerUser._id.toString() });

      expect(revokeRes.status).toBe(200);

      const perm = await Permission.findOne({
        documentId: ownerDoc._id,
        userId: viewerUser._id,
      });
      expect(perm).toBeNull();
    });
  });
});
