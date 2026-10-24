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
  // 3. EDIT METADATA (PATCH /documents/:id)
  // =========================================================================
  describe('PATCH /documents/:id (Edit Document Metadata)', () => {
    it('should allow document owner to update title and description and record audit event', async () => {
      const response = await request(app)
        .patch(`/documents/${ownerDoc._id}`)
        .set('Cookie', ownerCookie)
        .send({
          title: 'Updated Owner Doc Title',
          description: 'Updated Owner Description 2026',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('document');
      expect(response.body.document.title).toBe('Updated Owner Doc Title');
      expect(response.body.document.description).toBe('Updated Owner Description 2026');

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

    it('should prevent tampering with immutable fields (fileStorageName, sha256, ownerId)', async () => {
      const originalStorageName = ownerDoc.fileStorageName;
      const originalSha256 = ownerDoc.sha256;
      const originalOwnerId = ownerDoc.ownerId;

      const response = await request(app)
        .patch(`/documents/${ownerDoc._id}`)
        .set('Cookie', ownerCookie)
        .send({
          title: 'Valid New Title',
          fileStorageName: 'tampered-uuid-5555',
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          ownerId: viewerUser._id,
        });

      expect(response.status).toBe(200);
      expect(response.body.document.title).toBe('Valid New Title');
      expect(response.body.document.fileStorageName).toBe(originalStorageName);
      expect(response.body.document.sha256).toBe(originalSha256);
      expect(response.body.document.ownerId.toString()).toBe(originalOwnerId.toString());
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

    it('should allow document owner to delete document, removing physical disk file and permissions', async () => {
      // Create a dedicated doc to delete
      const docToDelete = await (async () => {
        const res = await request(app)
          .post('/documents/upload')
          .set('Cookie', ownerCookie)
          .attach('file', SAMPLE_PDF_BUFFER, 'delete_target.pdf')
          .field('title', 'Target For Deletion');
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

      // 1. Verify document removed from DB
      const dbDoc = await Document.findById(docToDelete._id);
      expect(dbDoc).toBeNull();

      // 2. Verify physical disk file removed
      expect(fs.existsSync(filePath)).toBe(false);

      // 3. Verify permissions on this document cleaned up
      const perms = await Permission.find({ documentId: docToDelete._id });
      expect(perms).toHaveLength(0);

      // 4. Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'DOCUMENT_DELETE',
        documentId: docToDelete._id,
        userId: ownerUser._id,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('SUCCESS');
      expect(auditLog.action).toBe('delete');
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
});
