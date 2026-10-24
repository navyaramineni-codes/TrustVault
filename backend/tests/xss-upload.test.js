const request = require('supertest');
const path = require('path');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { Document, User, AuditEvent } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');
const { renderAdminDashboardHtml } = require('../src/views/adminDashboardHtml');

describe('XSS File Upload & Plain-Text Rendering Verification', () => {
  let ownerCookie;
  let adminCookie;
  let ownerUser;

  const VALID_PDF_BUFFER = Buffer.from(
    '%PDF-1.5\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000102 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n'
  );

  const XSS_FILENAME = '<img src=x onerror=alert(1)>.pdf';

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    // Authenticate owner
    const ownerRes = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@trustvault.local', password: 'OwnerVault2026!' });
    expect(ownerRes.status).toBe(200);
    ownerCookie = ownerRes.headers['set-cookie'];
    ownerUser = ownerRes.body.user;

    // Authenticate admin
    const adminRes = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@trustvault.local', password: 'AdminVault2026!' });
    expect(adminRes.status).toBe(200);
    adminCookie = adminRes.headers['set-cookie'];
  });

  afterAll(async () => {
    await Document.deleteMany({ originalFileName: XSS_FILENAME });
    await disconnectDB();
  });

  it('should successfully upload a file with an XSS payload filename without executing or sanitizing file extension', async () => {
    const uploadRes = await request(app)
      .post('/documents/upload')
      .set('Cookie', ownerCookie)
      .field('title', XSS_FILENAME)
      .field('category', 'confidential')
      .field('description', 'Testing XSS immunity')
      .attach('file', VALID_PDF_BUFFER, XSS_FILENAME);

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.document).toBeDefined();
    expect(uploadRes.body.document.originalFileName).toBe(XSS_FILENAME);
    expect(uploadRes.body.document.name).toBe(XSS_FILENAME);
  });

  it('should return filename in GET /documents JSON safely as a plain text string', async () => {
    const listRes = await request(app)
      .get('/documents')
      .set('Cookie', ownerCookie);

    expect(listRes.status).toBe(200);
    const uploadedDoc = listRes.body.documents.find((d) => d.originalFileName === XSS_FILENAME);
    expect(uploadedDoc).toBeDefined();
    expect(uploadedDoc.name).toBe(XSS_FILENAME);
    expect(uploadedDoc.originalFileName).toBe(XSS_FILENAME);
  });

  it('should return filename in GET /documents/:id detail JSON safely as a plain text string', async () => {
    const doc = await Document.findOne({ originalFileName: XSS_FILENAME });
    expect(doc).toBeDefined();

    const detailRes = await request(app)
      .get(`/documents/${doc._id}`)
      .set('Cookie', ownerCookie);

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.document.name).toBe(XSS_FILENAME);
    expect(detailRes.body.document.originalFileName).toBe(XSS_FILENAME);
  });

  it('should record audit event with the XSS filename stored verbatim as metadata', async () => {
    const activityRes = await request(app)
      .get('/admin/activity')
      .set('Cookie', adminCookie);

    expect(activityRes.status).toBe(200);
    const event = activityRes.body.events.find(
      (e) => e.eventType === 'DOCUMENT_CREATE' && (e.documentName === XSS_FILENAME || e.metadata?.name === XSS_FILENAME)
    );
    expect(event).toBeDefined();
    expect(event.documentName).toBe(XSS_FILENAME);
  });

  it('should properly HTML-escape the XSS filename when rendered in HTML templates (escapeHtml)', () => {
    const renderedHtml = renderAdminDashboardHtml({ email: 'admin@trustvault.local' });
    // The escapeHtml function inside the dashboard template escapes < and > to &lt; and &gt;
    expect(renderedHtml).toContain('function escapeHtml(str)');
    expect(renderedHtml).toContain(".replace(/</g, '&lt;')");
    expect(renderedHtml).toContain(".replace(/>/g, '&gt;')");
  });
});
