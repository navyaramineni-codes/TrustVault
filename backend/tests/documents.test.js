const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User, Document, Permission, AuditEvent } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');

describe('Document Lifecycle Management (List, Download, Edit Metadata, Delete) via authorize()', () => {
  let ownerCookie;
  let ownerUser;
  let viewerCookie;
  let viewerUser;
  let adminCookie;
  let adminUser;

  const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage', 'documents');

  const SAMPLE_PDF_BUFFER = Buffer.from(
    '%PDF-1.5\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000102 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n'
  );

  let ownerDoc;
  let sharedReadDoc;
  let sharedEditDoc;
  let unsharedDoc;

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    // 1. Authenticate owner
    const ownerLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@trustvault.local', password: 'OwnerVault2026!' });
    expect(ownerLogin.status).toBe(200);
    ownerCookie = ownerLogin.headers['set-cookie'];
    ownerUser = ownerLogin.body.user;

    // 2. Authenticate viewer
    const viewerLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'viewer@trustvault.local', password: 'ViewerVault2026!' });
    expect(viewerLogin.status).toBe(200);
    viewerCookie = viewerLogin.headers['set-cookie'];
    viewerUser = viewerLogin.body.user;

    // 3. Authenticate admin
    const adminLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@trustvault.local', password: 'AdminVault2026!' });
    expect(adminLogin.status).toBe(200);
    adminCookie = adminLogin.headers['set-cookie'];
    adminUser = adminLogin.body.user;

    await fs.promises.mkdir(STORAGE_DIR, { recursive: true });

    // Helper to upload document directly through endpoint
    async function createTestDoc(title, fileName) {
      const res = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', SAMPLE_PDF_BUFFER, fileName)
        .field('title', title)
        .field('description', `Description for ${title}`);
      expect(res.status).toBe(201);
      return res.body.document;
    }

    ownerDoc = await createTestDoc('Doc Owned By Owner', 'owner_doc.pdf');
    sharedReadDoc = await createTestDoc('Doc Shared Read Only', 'shared_read.pdf');
    sharedEditDoc = await createTestDoc('Doc Shared Edit', 'shared_edit.pdf');
    unsharedDoc = await createTestDoc('Private Unshared Doc', 'private_unshared.pdf');

    // Grant viewer read permission on sharedReadDoc
    await Permission.create({
      documentId: sharedReadDoc._id,
      userId: viewerUser._id,
      level: 'read',
      grantedBy: ownerUser._id,
    });

    // Grant viewer edit permission on sharedEditDoc
    await Permission.create({
      documentId: sharedEditDoc._id,
      userId: viewerUser._id,
      level: 'edit',
      grantedBy: ownerUser._id,
    });
  });

  afterAll(async () => {
    try {
      // Clean up test documents in DB
      const docs = await Document.find({ ownerId: ownerUser._id });
      for (const d of docs) {
        const filePath = path.join(STORAGE_DIR, d.fileStorageName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      await Document.deleteMany({ ownerId: ownerUser._id });
      await Permission.deleteMany({ grantedBy: ownerUser._id });
    } finally {
      await disconnectDB();
    }
  });

  // =========================================================================
  // 1. LIST DOCUMENTS (GET /documents)
  // =========================================================================
  describe('GET /documents (List Documents)', () => {
    it('should return all owned documents for document owner', async () => {
      const response = await request(app)
        .get('/documents')
        .set('Cookie', ownerCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('documents');
      expect(Array.isArray(response.body.documents)).toBe(true);

      const docIds = response.body.documents.map((d) => d._id.toString());
      expect(docIds).toContain(ownerDoc._id.toString());
      expect(docIds).toContain(sharedReadDoc._id.toString());
      expect(docIds).toContain(sharedEditDoc._id.toString());
      expect(docIds).toContain(unsharedDoc._id.toString());
    });

    it('should return only granted documents for viewer (database-level permission filtered per Rule 6)', async () => {
      const response = await request(app)
        .get('/documents')
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('documents');
      const docIds = response.body.documents.map((d) => d._id.toString());

      // Viewer should see only documents with explicit permissions
      expect(docIds).toContain(sharedReadDoc._id.toString());
      expect(docIds).toContain(sharedEditDoc._id.toString());

      // Viewer MUST NOT see unshared documents
      expect(docIds).not.toContain(ownerDoc._id.toString());
      expect(docIds).not.toContain(unsharedDoc._id.toString());
    });

    it('should return empty list for admin who has no grants or ownership per Rule 4', async () => {
      const response = await request(app)
        .get('/documents')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('documents');
      const docIds = response.body.documents.map((d) => d._id.toString());
      expect(docIds).not.toContain(ownerDoc._id.toString());
      expect(docIds).not.toContain(unsharedDoc._id.toString());
    });

    it('should reject unauthenticated list request with 401', async () => {
      const response = await request(app).get('/documents');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
  });

  // =========================================================================
  // 2. DOWNLOAD DOCUMENT (GET /documents/:id/download)
  // =========================================================================
  describe('GET /documents/:id/download (Streamed Download with Content-Disposition: attachment)', () => {
    it('should stream document with Content-Disposition: attachment for document owner and write audit event', async () => {
      const response = await request(app)
        .get(`/documents/${ownerDoc._id}/download`)
        .set('Cookie', ownerCookie);

      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toMatch(/attachment;\s*filename=/i);
      expect(response.headers['content-disposition']).toContain('owner_doc.pdf');
      expect(response.headers['content-type']).toBe('application/pdf');

      // Verify streamed byte content integrity
      expect(response.body).toBeInstanceOf(Buffer);
      const downloadedSha256 = crypto.createHash('sha256').update(response.body).digest('hex');
      expect(downloadedSha256).toBe(ownerDoc.sha256);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'DOCUMENT_DOWNLOAD',
        documentId: ownerDoc._id,
        userId: ownerUser._id,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('SUCCESS');
      expect(auditLog.action).toBe('read');
    });

    it('should stream document for viewer with granted "read" permission', async () => {
      const response = await request(app)
        .get(`/documents/${sharedReadDoc._id}/download`)
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toMatch(/attachment;\s*filename=/i);
      expect(response.headers['content-disposition']).toContain('shared_read.pdf');
      expect(response.headers['content-type']).toBe('application/pdf');
    });

    it('should stream document for viewer with granted "edit" permission', async () => {
      const response = await request(app)
        .get(`/documents/${sharedEditDoc._id}/download`)
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toMatch(/attachment;\s*filename=/i);
      expect(response.headers['content-disposition']).toContain('shared_edit.pdf');
    });

    it('should return 404 (never 403 per Rule 3) for viewer attempting to download unshared document and log denial audit event', async () => {
      const response = await request(app)
        .get(`/documents/${unsharedDoc._id}/download`)
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });

      // Verify AuditEvent write for denied attempt
      const auditLog = await AuditEvent.findOne({
        eventType: 'ACCESS_DENIED',
        documentId: unsharedDoc._id,
        userId: viewerUser._id,
        action: 'read',
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    it('should return 404 for admin attempting to download without explicit grant per Rule 4', async () => {
      const response = await request(app)
        .get(`/documents/${unsharedDoc._id}/download`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for non-existent document ID', async () => {
      const nonExistentId = new User()._id;
      const response = await request(app)
        .get(`/documents/${nonExistentId}/download`)
        .set('Cookie', ownerCookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });
    });

    it('should reject unauthenticated download with 401', async () => {
      const response = await request(app)
        .get(`/documents/${ownerDoc._id}/download`);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
  });

  // =========================================================================
  // 2B. GET DOCUMENT DETAIL (GET /documents/:id)
  // =========================================================================
  describe('GET /documents/:id (Document Detail & Permission Calculation)', () => {
    it('should return document detail with owner permissions for document owner', async () => {
      const response = await request(app)
        .get(`/documents/${ownerDoc._id}`)
        .set('Cookie', ownerCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('document');
      expect(response.body).toHaveProperty('permissions');
      expect(response.body.document._id.toString()).toBe(ownerDoc._id.toString());
      expect(response.body.document.ownerEmail).toBe(ownerUser.email);
      expect(response.body.permissions).toEqual({
        isOwner: true,
        canEdit: true,
        canDelete: true,
        level: 'owner',
      });
    });

    it('should return document detail with edit permissions for viewer granted "edit"', async () => {
      const response = await request(app)
        .get(`/documents/${sharedEditDoc._id}`)
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('document');
      expect(response.body.permissions).toEqual({
        isOwner: false,
        canEdit: true,
        canDelete: false,
        level: 'edit',
      });
    });

    it('should return document detail with read-only permissions for viewer granted "read"', async () => {
      const response = await request(app)
        .get(`/documents/${sharedReadDoc._id}`)
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('document');
      expect(response.body.permissions).toEqual({
        isOwner: false,
        canEdit: false,
        canDelete: false,
        level: 'read',
      });
    });

    it('should return 404 for viewer attempting to view unshared document detail per Rule 3', async () => {
      const response = await request(app)
        .get(`/documents/${unsharedDoc._id}`)
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });
    });

    it('should return 401 for unauthenticated request to document detail', async () => {
      const response = await request(app)
        .get(`/documents/${ownerDoc._id}`);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
  });

  // =========================================================================
  // 3. EDIT METADATA (PATCH /documents/:id)
  // =========================================================================
  describe('PATCH /documents/:id (Edit Document Metadata)', () => {
    it('should allow document owner to update title, name, description, category, and tags and record audit event', async () => {
      const response = await request(app)
        .patch(`/documents/${ownerDoc._id}`)
        .set('Cookie', ownerCookie)
        .send({
          name: 'Updated Owner Doc Title',
          title: 'Updated Owner Doc Title',
          description: 'Updated Owner Description 2026',
          category: 'financial',
          tags: ['q1', 'audit', 'confidential'],
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('document');
      expect(response.body.document.name).toBe('Updated Owner Doc Title');
      expect(response.body.document.title).toBe('Updated Owner Doc Title');
      expect(response.body.document.description).toBe('Updated Owner Description 2026');
      expect(response.body.document.category).toBe('financial');
      expect(response.body.document.tags).toEqual(['q1', 'audit', 'confidential']);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'DOCUMENT_UPDATE',
        documentId: ownerDoc._id,
        userId: ownerUser._id,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('SUCCESS');
      expect(auditLog.action).toBe('edit');
    });

    it('should allow viewer with "edit" grant to update document metadata', async () => {
      const response = await request(app)
        .patch(`/documents/${sharedEditDoc._id}`)
        .set('Cookie', viewerCookie)
        .send({
          title: 'Edited by Viewer with Edit Grant',
          description: 'Viewer updated description',
        });

      expect(response.status).toBe(200);
      expect(response.body.document.title).toBe('Edited by Viewer with Edit Grant');
    });

    it('should deny viewer with "read" grant from editing metadata with 404 (never 403 per Rule 3 & 4)', async () => {
      const response = await request(app)
        .patch(`/documents/${sharedReadDoc._id}`)
        .set('Cookie', viewerCookie)
        .send({
          title: 'Unauthorized Edit Attempt by Read-Only Viewer',
        });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });

      // Verify AuditEvent write for denied attempt
      const auditLog = await AuditEvent.findOne({
        eventType: 'ACCESS_DENIED',
        documentId: sharedReadDoc._id,
        userId: viewerUser._id,
        action: 'edit',
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    it('should deny admin from editing metadata on unowned document without grant with 404', async () => {
      const response = await request(app)
        .patch(`/documents/${unsharedDoc._id}`)
        .set('Cookie', adminCookie)
        .send({
          title: 'Admin Snooping Edit Attempt',
        });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });
    });

    it('should prevent tampering with immutable fields (fileStorageName, storagePath, sha256, ownerId, owner)', async () => {
      const originalStorageName = ownerDoc.fileStorageName;
      const originalStoragePath = ownerDoc.storagePath;
      const originalSha256 = ownerDoc.sha256;
      const originalOwnerId = ownerDoc.ownerId;
      const originalOwner = ownerDoc.owner;

      const response = await request(app)
        .patch(`/documents/${ownerDoc._id}`)
        .set('Cookie', ownerCookie)
        .send({
          name: 'Valid New Title',
          title: 'Valid New Title',
          fileStorageName: 'tampered-uuid-5555',
          storagePath: 'tampered-uuid-5555',
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          ownerId: viewerUser._id,
          owner: viewerUser._id,
        });

      expect(response.status).toBe(200);
      expect(response.body.document.title).toBe('Valid New Title');
      expect(response.body.document.name).toBe('Valid New Title');
      expect(response.body.document.fileStorageName).toBe(originalStorageName);
      expect(response.body.document.storagePath).toBe(originalStoragePath);
      expect(response.body.document.sha256).toBe(originalSha256);
      expect(response.body.document.ownerId.toString()).toBe(originalOwnerId.toString());
      expect(response.body.document.owner.toString()).toBe(originalOwner.toString());
    });

    it('should reject unauthenticated edit metadata request with 401', async () => {
      const response = await request(app)
        .patch(`/documents/${ownerDoc._id}`)
        .send({ title: 'Unauth Title' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
  });

  // =========================================================================
  // 4. DELETE DOCUMENT (DELETE /documents/:id)
  // =========================================================================
  describe('DELETE /documents/:id (Delete Document & Associated Physical File/Permissions)', () => {
    it('should deny viewer with "edit" grant from deleting document with 404 (Rule 4: delete always denied to viewers)', async () => {
      const response = await request(app)
        .delete(`/documents/${sharedEditDoc._id}`)
        .set('Cookie', viewerCookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });

      // Verify AuditEvent write for denied delete
      const auditLog = await AuditEvent.findOne({
        eventType: 'ACCESS_DENIED',
        documentId: sharedEditDoc._id,
        userId: viewerUser._id,
        action: 'delete',
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    it('should deny admin without ownership from deleting document with 404', async () => {
      const response = await request(app)
        .delete(`/documents/${unsharedDoc._id}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });
    });

    it('should allow document owner to soft-delete document by setting deletedAt timestamp while retaining record in DB for audit log references', async () => {
      // Create a dedicated doc to soft-delete
      const docToDelete = await (async () => {
        const res = await request(app)
          .post('/documents/upload')
          .set('Cookie', ownerCookie)
          .attach('file', SAMPLE_PDF_BUFFER, 'soft_delete_target.pdf')
          .field('title', 'Soft Delete Target');
        return res.body.document;
      })();

      // Verify physical disk file exists prior to delete
      const filePath = path.join(STORAGE_DIR, docToDelete.fileStorageName);
      expect(fs.existsSync(filePath)).toBe(true);

      // Create a permission record on this doc
      await Permission.create({
        documentId: docToDelete._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });

      const response = await request(app)
        .delete(`/documents/${docToDelete._id}`)
        .set('Cookie', ownerCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Document deleted successfully');

      // 1. Verify document is NOT removed from DB, but has deletedAt set as a Date
      const dbDoc = await Document.findById(docToDelete._id);
      expect(dbDoc).not.toBeNull();
      expect(dbDoc.deletedAt).toBeInstanceOf(Date);
      expect(Date.now() - new Date(dbDoc.deletedAt).getTime()).toBeLessThan(10000);

      // 2. Verify AuditEvent write and that audit log can still reference it
      const auditLog = await AuditEvent.findOne({
        eventType: 'DOCUMENT_DELETE',
        documentId: docToDelete._id,
        userId: ownerUser._id,
      }).populate('documentId');

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('SUCCESS');
      expect(auditLog.action).toBe('delete');
      expect(auditLog.documentId).not.toBeNull();
      expect(auditLog.documentId._id.toString()).toBe(docToDelete._id.toString());
      expect(auditLog.documentId.title).toBe('Soft Delete Target');
      expect(auditLog.documentId.deletedAt).toBeInstanceOf(Date);
    });

    it('should return 404 for everyone (including owner, viewers, and admin) on every route for a soft-deleted document', async () => {
      // Create and soft-delete a document
      const softDoc = await (async () => {
        const res = await request(app)
          .post('/documents/upload')
          .set('Cookie', ownerCookie)
          .attach('file', SAMPLE_PDF_BUFFER, 'perma_hidden.pdf')
          .field('title', 'Perma Hidden Doc');
        return res.body.document;
      })();

      // Grant edit to viewer
      await Permission.create({
        documentId: softDoc._id,
        userId: viewerUser._id,
        level: 'edit',
        grantedBy: ownerUser._id,
      });

      // Soft delete the document
      const delRes = await request(app)
        .delete(`/documents/${softDoc._id}`)
        .set('Cookie', ownerCookie);
      expect(delRes.status).toBe(200);

      // 1. GET /:id and GET /:id/download must return 404 for EVERYONE (owner, viewer, admin)
      const getDocOwner = await request(app)
        .get(`/documents/${softDoc._id}`)
        .set('Cookie', ownerCookie);
      expect(getDocOwner.status).toBe(404);
      expect(getDocOwner.body).toEqual({ error: 'Not Found' });

      const getDocViewer = await request(app)
        .get(`/documents/${softDoc._id}`)
        .set('Cookie', viewerCookie);
      expect(getDocViewer.status).toBe(404);
      expect(getDocViewer.body).toEqual({ error: 'Not Found' });

      const getDocAdmin = await request(app)
        .get(`/documents/${softDoc._id}`)
        .set('Cookie', adminCookie);
      expect(getDocAdmin.status).toBe(404);
      expect(getDocAdmin.body).toEqual({ error: 'Not Found' });

      const downloadOwner = await request(app)
        .get(`/documents/${softDoc._id}/download`)
        .set('Cookie', ownerCookie);
      expect(downloadOwner.status).toBe(404);
      expect(downloadOwner.body).toEqual({ error: 'Not Found' });

      const downloadViewer = await request(app)
        .get(`/documents/${softDoc._id}/download`)
        .set('Cookie', viewerCookie);
      expect(downloadViewer.status).toBe(404);
      expect(downloadViewer.body).toEqual({ error: 'Not Found' });

      const downloadAdmin = await request(app)
        .get(`/documents/${softDoc._id}/download`)
        .set('Cookie', adminCookie);
      expect(downloadAdmin.status).toBe(404);
      expect(downloadAdmin.body).toEqual({ error: 'Not Found' });

      // 2. PATCH /:id must return 404 for EVERYONE
      const patchOwner = await request(app)
        .patch(`/documents/${softDoc._id}`)
        .set('Cookie', ownerCookie)
        .send({ title: 'New Title Attempt' });
      expect(patchOwner.status).toBe(404);
      expect(patchOwner.body).toEqual({ error: 'Not Found' });

      const patchViewer = await request(app)
        .patch(`/documents/${softDoc._id}`)
        .set('Cookie', viewerCookie)
        .send({ title: 'New Title Attempt' });
      expect(patchViewer.status).toBe(404);
      expect(patchViewer.body).toEqual({ error: 'Not Found' });

      const patchAdmin = await request(app)
        .patch(`/documents/${softDoc._id}`)
        .set('Cookie', adminCookie)
        .send({ title: 'New Title Attempt' });
      expect(patchAdmin.status).toBe(404);
      expect(patchAdmin.body).toEqual({ error: 'Not Found' });

      // 3. PUT /:id must return 404 for EVERYONE
      const putOwner = await request(app)
        .put(`/documents/${softDoc._id}`)
        .set('Cookie', ownerCookie)
        .send({ title: 'Put Title Attempt' });
      expect(putOwner.status).toBe(404);
      expect(putOwner.body).toEqual({ error: 'Not Found' });

      // 4. DELETE /:id on an already soft-deleted document must return 404 for EVERYONE
      const deleteOwnerAgain = await request(app)
        .delete(`/documents/${softDoc._id}`)
        .set('Cookie', ownerCookie);
      expect(deleteOwnerAgain.status).toBe(404);
      expect(deleteOwnerAgain.body).toEqual({ error: 'Not Found' });

      const deleteViewer = await request(app)
        .delete(`/documents/${softDoc._id}`)
        .set('Cookie', viewerCookie);
      expect(deleteViewer.status).toBe(404);
      expect(deleteViewer.body).toEqual({ error: 'Not Found' });

      const deleteAdmin = await request(app)
        .delete(`/documents/${softDoc._id}`)
        .set('Cookie', adminCookie);
      expect(deleteAdmin.status).toBe(404);
      expect(deleteAdmin.body).toEqual({ error: 'Not Found' });
    });

    it('should not appear in list or search for any user after being soft-deleted', async () => {
      // Create a document with a unique searchable keyword
      const searchDoc = await (async () => {
        const res = await request(app)
          .post('/documents/upload')
          .set('Cookie', ownerCookie)
          .attach('file', SAMPLE_PDF_BUFFER, 'findme_secret.pdf')
          .field('title', 'FindMeSecret KeywordDoc');
        return res.body.document;
      })();

      // Grant read permission to viewer
      await Permission.create({
        documentId: searchDoc._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });

      // Verify it appears in list before deletion
      const listBefore = await request(app)
        .get('/documents')
        .set('Cookie', ownerCookie);
      const idsBefore = listBefore.body.documents.map((d) => d._id.toString());
      expect(idsBefore).toContain(searchDoc._id.toString());

      // Soft-delete the document
      await request(app)
        .delete(`/documents/${searchDoc._id}`)
        .set('Cookie', ownerCookie);

      // 1. Must not appear in list for owner
      const listOwner = await request(app)
        .get('/documents')
        .set('Cookie', ownerCookie);
      const ownerIds = listOwner.body.documents.map((d) => d._id.toString());
      expect(ownerIds).not.toContain(searchDoc._id.toString());

      // 2. Must not appear in list for viewer
      const listViewer = await request(app)
        .get('/documents')
        .set('Cookie', viewerCookie);
      const viewerIds = listViewer.body.documents.map((d) => d._id.toString());
      expect(viewerIds).not.toContain(searchDoc._id.toString());

      // 3. Must not appear in search by query parameter for owner
      const searchOwner = await request(app)
        .get('/documents?search=FindMeSecret')
        .set('Cookie', ownerCookie);
      const searchOwnerIds = (searchOwner.body.documents || []).map((d) => d._id.toString());
      expect(searchOwnerIds).not.toContain(searchDoc._id.toString());

      // 4. Must not appear in search by dedicated search route for owner
      const searchRouteOwner = await request(app)
        .get('/documents/search?q=FindMeSecret')
        .set('Cookie', ownerCookie);
      const searchRouteIds = (searchRouteOwner.body.documents || []).map((d) => d._id.toString());
      expect(searchRouteIds).not.toContain(searchDoc._id.toString());

      // 5. Must not appear in search for viewer
      const searchViewer = await request(app)
        .get('/documents?q=FindMeSecret')
        .set('Cookie', viewerCookie);
      const searchViewerIds = (searchViewer.body.documents || []).map((d) => d._id.toString());
      expect(searchViewerIds).not.toContain(searchDoc._id.toString());
    });

    it('should reject soft-deleted document in authorize() with 404 for all actions and roles', async () => {
      const softDoc = await Document.create({
        name: 'Authz Soft Deleted Doc',
        title: 'Authz Soft Deleted Doc',
        owner: ownerUser._id,
        ownerId: ownerUser._id,
        size: 1024,
        sizeBytes: 1024,
        mimeType: 'application/pdf',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        storagePath: 'soft-del-uuid',
        fileStorageName: 'soft-del-uuid',
        deletedAt: new Date(),
      });

      const { authorize } = require('../src/authz');

      // Test all actions for owner: read, edit, delete, grant
      for (const act of ['read', 'edit', 'delete', 'grant']) {
        await expect(authorize(ownerUser, softDoc, act)).rejects.toMatchObject({
          status: 404,
        });
      }

      // Test for viewer and admin
      await expect(authorize(viewerUser, softDoc, 'read')).rejects.toMatchObject({
        status: 404,
      });
      await expect(authorize(adminUser, softDoc, 'read')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('should return 404 when attempting to delete non-existent document', async () => {
      const nonExistentId = new User()._id;
      const response = await request(app)
        .delete(`/documents/${nonExistentId}`)
        .set('Cookie', ownerCookie);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });
    });

    it('should reject unauthenticated delete with 401', async () => {
      const response = await request(app)
        .delete(`/documents/${ownerDoc._id}`);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
  });

  describe('Document Sharing & Permissions Management (Owner Only) via authorize()', () => {
    let shareDoc;

    beforeEach(async () => {
      const res = await request(app)
        .post('/documents/upload')
        .set('Cookie', ownerCookie)
        .attach('file', SAMPLE_PDF_BUFFER, 'sharing_test_doc.pdf')
        .field('title', 'Sharing Test Document');
      shareDoc = res.body.document;
    });

    describe('GET /documents/:id/permissions (List Active Permissions)', () => {
      it('should allow document owner to list active permissions with user email and level', async () => {
        // Grant read to viewer
        await Permission.create({
          documentId: shareDoc._id,
          userId: viewerUser._id,
          level: 'read',
          grantedBy: ownerUser._id,
        });

        const res = await request(app)
          .get(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', ownerCookie);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('count', 1);
        expect(Array.isArray(res.body.permissions)).toBe(true);
        expect(res.body.permissions[0].email).toBe(viewerUser.email);
        expect(res.body.permissions[0].level).toBe('read');
      });

      it('should return 404 (never 403 per Rule 3 & 4) for non-owner attempting to list permissions', async () => {
        // Even if viewer has edit permission on doc, listing ACL is owner-only
        await Permission.create({
          documentId: shareDoc._id,
          userId: viewerUser._id,
          level: 'edit',
          grantedBy: ownerUser._id,
        });

        const res = await request(app)
          .get(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', viewerCookie);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Not Found' });
      });

      it('should return 404 for admin attempting to list permissions on unowned doc', async () => {
        const res = await request(app)
          .get(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', adminCookie);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Not Found' });
      });
    });

    describe('POST /documents/:id/permissions (Grant Access by Name or Email)', () => {
      it('should allow owner to grant "read" access by username prefix ("viewer")', async () => {
        const res = await request(app)
          .post(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', ownerCookie)
          .send({ name: 'viewer', level: 'read' });

        expect(res.status).toBe(200);
        expect(res.body.message).toContain('Permission granted');
        expect(res.body.permission.level).toBe('read');
        expect(res.body.permission.email).toBe(viewerUser.email);

        // Verify viewer can now download the doc
        const dlRes = await request(app)
          .get(`/documents/${shareDoc._id}/download`)
          .set('Cookie', viewerCookie);
        expect(dlRes.status).toBe(200);

        // Verify audit event
        const audit = await AuditEvent.findOne({
          documentId: shareDoc._id,
          eventType: 'PERMISSION_GRANT',
        });
        expect(audit).not.toBeNull();
        expect(audit.status).toBe('SUCCESS');
      });

      it('should allow owner to grant "edit" access by full email address', async () => {
        const res = await request(app)
          .post(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', ownerCookie)
          .send({ name: viewerUser.email, level: 'edit' });

        expect(res.status).toBe(200);
        expect(res.body.permission.level).toBe('edit');

        // Verify viewer can now edit metadata
        const patchRes = await request(app)
          .patch(`/documents/${shareDoc._id}`)
          .set('Cookie', viewerCookie)
          .send({ title: 'Updated by Granted Viewer' });
        expect(patchRes.status).toBe(200);
      });

      it('should reject granting access to the document owner with 400', async () => {
        const res = await request(app)
          .post(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', ownerCookie)
          .send({ name: ownerUser.email, level: 'edit' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('owner');
      });

      it('should return 404 when target user name/email does not exist', async () => {
        const res = await request(app)
          .post(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', ownerCookie)
          .send({ name: 'nonexistent_user_9999', level: 'read' });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it('should return 404 for viewer attempting to grant permissions (Rule 4: grant always denied to viewers)', async () => {
        const res = await request(app)
          .post(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', viewerCookie)
          .send({ name: 'admin', level: 'read' });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Not Found' });
      });
    });

    describe('DELETE /documents/:id/permissions/:userId (Revoke Access)', () => {
      it('should allow owner to revoke permission and immediately cut off access', async () => {
        // First grant access
        await request(app)
          .post(`/documents/${shareDoc._id}/permissions`)
          .set('Cookie', ownerCookie)
          .send({ name: viewerUser.email, level: 'read' });

        // Verify access works
        const checkBefore = await request(app)
          .get(`/documents/${shareDoc._id}`)
          .set('Cookie', viewerCookie);
        expect(checkBefore.status).toBe(200);

        // Revoke access
        const revokeRes = await request(app)
          .delete(`/documents/${shareDoc._id}/permissions/${viewerUser._id}`)
          .set('Cookie', ownerCookie);

        expect(revokeRes.status).toBe(200);
        expect(revokeRes.body.message).toContain('revoked');

        // Verify access is immediately denied with 404
        const checkAfter = await request(app)
          .get(`/documents/${shareDoc._id}`)
          .set('Cookie', viewerCookie);
        expect(checkAfter.status).toBe(404);

        // Verify download is denied with 404
        const dlAfter = await request(app)
          .get(`/documents/${shareDoc._id}/download`)
          .set('Cookie', viewerCookie);
        expect(dlAfter.status).toBe(404);

        // Verify audit event
        const audit = await AuditEvent.findOne({
          documentId: shareDoc._id,
          eventType: 'PERMISSION_REVOKE',
        });
        expect(audit).not.toBeNull();
        expect(audit.status).toBe('SUCCESS');
      });

      it('should return 404 for viewer attempting to revoke permissions', async () => {
        const res = await request(app)
          .delete(`/documents/${shareDoc._id}/permissions/${viewerUser._id}`)
          .set('Cookie', viewerCookie);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Not Found' });
      });
    });
  });
});
