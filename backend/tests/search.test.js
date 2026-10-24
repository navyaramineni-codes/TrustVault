const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { Document, Permission, User, AuditEvent } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');

describe('Document Search & Anti-Leakage Specification', () => {
  let ownerCookie;
  let viewerCookie;
  let ownerUser;
  let viewerUser;
  let otherOwnerUser;
  let otherOwnerCookie;

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    ownerUser = await User.findOne({ email: 'owner@trustvault.local' });
    viewerUser = await User.findOne({ email: 'viewer@trustvault.local' });

    // Create another user to test cross-owner searching
    otherOwnerUser = await User.findOneAndUpdate(
      { email: 'other-owner@trustvault.local' },
      {
        email: 'other-owner@trustvault.local',
        passwordHash: 'dummyhash',
        role: 'user',
        isActive: true,
      },
      { upsert: true, new: true }
    );

    // Login as owner
    const ownerLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@trustvault.local', password: 'OwnerVault2026!' });
    ownerCookie = ownerLogin.headers['set-cookie'];

    // Login as viewer
    const viewerLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'viewer@trustvault.local', password: 'ViewerVault2026!' });
    viewerCookie = viewerLogin.headers['set-cookie'];
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // =========================================================================
  // 1. LEAKAGE TEST (40 Matching Docs, Viewer Has 3 Grants -> Exactly 3 Results)
  // =========================================================================
  describe('Leakage Prevention Test (Strict DB-Level Filtering)', () => {
    const SEARCH_TERM = 'quarterly-audit-report-leakage-target';
    const grantedDocIds = [];

    beforeAll(async () => {
      // Clean up previous documents matching this term
      await Document.deleteMany({ name: new RegExp(SEARCH_TERM, 'i') });

      // Create 40 documents owned by ownerUser that all match SEARCH_TERM
      const docsToInsert = [];
      for (let i = 1; i <= 40; i++) {
        const dummyUuid = crypto.randomUUID();
        const dummySha = crypto.createHash('sha256').update(`content_${i}`).digest('hex');
        docsToInsert.push({
          name: `${SEARCH_TERM}-${i}.pdf`,
          title: `Financial Statement ${SEARCH_TERM} #${i}`,
          description: `Internal financial data matching ${SEARCH_TERM}`,
          category: 'finance',
          tags: ['financial', 'confidential', 'quarterly'],
          storagePath: dummyUuid,
          fileStorageName: dummyUuid,
          originalFileName: `${SEARCH_TERM}-${i}.pdf`,
          mimeType: 'application/pdf',
          size: 1024,
          sizeBytes: 1024,
          sha256: dummySha,
          owner: ownerUser._id,
          ownerId: ownerUser._id,
          deletedAt: null,
          createdAt: new Date(),
        });
      }

      const createdDocs = await Document.insertMany(docsToInsert);

      // Grant 'read' permissions on exactly 3 of the 40 documents to the viewer
      for (let i = 0; i < 3; i++) {
        const docToGrant = createdDocs[i];
        grantedDocIds.push(docToGrant._id.toString());
        await Permission.create({
          documentId: docToGrant._id,
          userId: viewerUser._id,
          level: 'read',
          grantedBy: ownerUser._id,
        });
      }
    });

    it('should return exactly 3 results and count of 3 for viewer when 40 documents match search term', async () => {
      // Viewer executes search
      const res = await request(app)
        .get(`/documents/search?q=${SEARCH_TERM}`)
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);

      const docs = res.body.documents || res.body.results;
      expect(Array.isArray(docs)).toBe(true);
      expect(docs.length).toBe(3);

      // Verify explicit count/total field is exactly 3 (no leakage of total 40)
      const count = res.body.count !== undefined ? res.body.count : res.body.total;
      expect(count).toBe(3);

      // Verify the returned documents are strictly the 3 granted ones
      const returnedIds = docs.map((d) => d._id.toString());
      expect(returnedIds.sort()).toEqual(grantedDocIds.sort());

      // Ensure none of the remaining 37 unshared documents leak
      for (const returnedDoc of docs) {
        expect(grantedDocIds).toContain(returnedDoc._id.toString());
      }
    });

    it('should return all 40 matching documents when owner executes the same search', async () => {
      const res = await request(app)
        .get(`/documents/search?q=${SEARCH_TERM}`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(40);
      const count = res.body.count !== undefined ? res.body.count : res.body.total;
      expect(count).toBe(40);
    });
  });

  // =========================================================================
  // 2. SEARCH BY NAME
  // =========================================================================
  describe('Search by Name / Title', () => {
    let doc1;
    let doc2;

    beforeAll(async () => {
      await Document.deleteMany({ name: /annual_budget|technical_architecture/i });

      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();

      doc1 = await Document.create({
        name: 'annual_budget_2026_spec.pdf',
        title: 'Annual Budget Specification 2026',
        description: 'Budget overview',
        category: 'finance',
        storagePath: uuid1,
        fileStorageName: uuid1,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('b1').digest('hex'),
        owner: ownerUser._id,
        ownerId: ownerUser._id,
      });

      doc2 = await Document.create({
        name: 'technical_architecture_diagram.pdf',
        title: 'Architecture Blueprint',
        description: 'System design',
        category: 'engineering',
        storagePath: uuid2,
        fileStorageName: uuid2,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('b2').digest('hex'),
        owner: ownerUser._id,
        ownerId: ownerUser._id,
      });

      // Grant doc1 to viewer
      await Permission.create({
        documentId: doc1._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });
    });

    it('should search by name parameter (?name=annual_budget)', async () => {
      const res = await request(app)
        .get('/documents/search?name=annual_budget')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0]._id.toString()).toBe(doc1._id.toString());
    });

    it('should return 0 results when viewer searches by name for ungranted document', async () => {
      const res = await request(app)
        .get('/documents/search?name=technical_architecture')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(0);
      const count = res.body.count !== undefined ? res.body.count : res.body.total;
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // 3. SEARCH BY OWNER
  // =========================================================================
  describe('Search by Owner (Email or ID)', () => {
    let ownerDoc;
    let otherOwnerDoc;

    beforeAll(async () => {
      await Document.deleteMany({ name: /owner_policy_guide|other_owner_contract/i });

      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();

      ownerDoc = await Document.create({
        name: 'owner_policy_guide.pdf',
        category: 'legal',
        storagePath: uuid1,
        fileStorageName: uuid1,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('o1').digest('hex'),
        owner: ownerUser._id,
        ownerId: ownerUser._id,
      });

      otherOwnerDoc = await Document.create({
        name: 'other_owner_contract.pdf',
        category: 'legal',
        storagePath: uuid2,
        fileStorageName: uuid2,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('o2').digest('hex'),
        owner: otherOwnerUser._id,
        ownerId: otherOwnerUser._id,
      });

      // Grant ownerDoc to viewer
      await Permission.create({
        documentId: ownerDoc._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });
    });

    it('should search by owner email (?owner=owner@trustvault.local)', async () => {
      const res = await request(app)
        .get('/documents/search?owner=owner@trustvault.local&category=legal')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0]._id.toString()).toBe(ownerDoc._id.toString());
    });

    it('should search by owner ID (?ownerId=<id>)', async () => {
      const res = await request(app)
        .get(`/documents/search?ownerId=${ownerUser._id.toString()}&category=legal`)
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0]._id.toString()).toBe(ownerDoc._id.toString());
    });

    it('should search by owner name prefix (?owner=owner)', async () => {
      const res = await request(app)
        .get('/documents/search?owner=owner&category=legal')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0]._id.toString()).toBe(ownerDoc._id.toString());
    });

    it('should return 0 results when searching for an owner whose documents are ungranted', async () => {
      const res = await request(app)
        .get(`/documents/search?owner=${otherOwnerUser.email}`)
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(0);
    });
  });

  // =========================================================================
  // 4. SEARCH BY CATEGORY
  // =========================================================================
  describe('Search by Category', () => {
    let hrDoc;
    let secDoc;

    beforeAll(async () => {
      await Document.deleteMany({ category: /human-resources|security-operations/i });

      const u1 = crypto.randomUUID();
      const u2 = crypto.randomUUID();

      hrDoc = await Document.create({
        name: 'hr_employee_handbook.pdf',
        category: 'human-resources',
        storagePath: u1,
        fileStorageName: u1,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('h1').digest('hex'),
        owner: ownerUser._id,
        ownerId: ownerUser._id,
      });

      secDoc = await Document.create({
        name: 'security_policy_handbook.pdf',
        category: 'security-operations',
        storagePath: u2,
        fileStorageName: u2,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('s1').digest('hex'),
        owner: ownerUser._id,
        ownerId: ownerUser._id,
      });

      // Grant hrDoc to viewer
      await Permission.create({
        documentId: hrDoc._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });
    });

    it('should search by category parameter (?category=human-resources)', async () => {
      const res = await request(app)
        .get('/documents/search?category=human-resources')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0].category).toBe('human-resources');
      expect(docs[0]._id.toString()).toBe(hrDoc._id.toString());
    });

    it('should return 0 results when searching category with no granted documents for viewer', async () => {
      const res = await request(app)
        .get('/documents/search?category=security-operations')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(0);
    });
  });

  // =========================================================================
  // 5. SEARCH BY DATE RANGE
  // =========================================================================
  describe('Search by Date Range (startDate, endDate, from, to)', () => {
    let pastDoc;
    let recentDoc;

    beforeAll(async () => {
      await Document.deleteMany({ category: 'archives' });

      const u1 = crypto.randomUUID();
      const u2 = crypto.randomUUID();

      // Document created 30 days ago
      pastDoc = await Document.create({
        name: 'past_quarterly_archive.pdf',
        category: 'archives',
        storagePath: u1,
        fileStorageName: u1,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('p1').digest('hex'),
        owner: ownerUser._id,
        ownerId: ownerUser._id,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      // Document created today
      recentDoc = await Document.create({
        name: 'recent_quarterly_archive.pdf',
        category: 'archives',
        storagePath: u2,
        fileStorageName: u2,
        mimeType: 'application/pdf',
        size: 500,
        sha256: crypto.createHash('sha256').update('p2').digest('hex'),
        owner: ownerUser._id,
        ownerId: ownerUser._id,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      // Grant both to viewer
      await Permission.create({
        documentId: pastDoc._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });
      await Permission.create({
        documentId: recentDoc._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });
    });

    it('should filter documents by date range (?startDate=2026-05-01&endDate=2026-07-01)', async () => {
      const res = await request(app)
        .get('/documents/search?startDate=2026-05-01&endDate=2026-07-01&category=archives')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0]._id.toString()).toBe(recentDoc._id.toString());
    });

    it('should support alternative date range parameters (?from=2025-12-01&to=2026-02-01)', async () => {
      const res = await request(app)
        .get('/documents/search?from=2025-12-01&to=2026-02-01&category=archives')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0]._id.toString()).toBe(pastDoc._id.toString());
    });

    it('should exclude soft-deleted documents from search results even if matching criteria', async () => {
      // Soft-delete pastDoc
      pastDoc.deletedAt = new Date();
      await pastDoc.save();

      const res = await request(app)
        .get('/documents/search?from=2025-12-01&to=2026-02-01&category=archives')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(0);
    });
  });

  // =========================================================================
  // 6. MULTI-CRITERIA SEARCH (NAME, OWNER, CATEGORY, DATE RANGE COMBINED)
  // =========================================================================
  describe('Multi-Criteria Search (Name, Owner, Category, Date Range)', () => {
    let multiDoc;

    beforeAll(async () => {
      const uuid = crypto.randomUUID();
      multiDoc = await Document.create({
        name: 'OmniFilter Target Document',
        title: 'OmniFilter Target Document',
        category: 'financial',
        owner: ownerUser._id,
        ownerId: ownerUser._id,
        storagePath: uuid,
        fileStorageName: uuid,
        sha256: crypto.createHash('sha256').update('omni').digest('hex'),
        mimeType: 'application/pdf',
        size: 2048,
        sizeBytes: 2048,
        createdAt: new Date('2026-04-15T12:00:00Z'),
        deletedAt: null,
      });

      await Permission.create({
        documentId: multiDoc._id,
        userId: viewerUser._id,
        level: 'read',
        grantedBy: ownerUser._id,
      });
    });

    it('should successfully match when all filters (name, owner, category, date range) align', async () => {
      const res = await request(app)
        .get('/documents/search?name=OmniFilter&owner=owner&category=financial&startDate=2026-04-01&endDate=2026-04-30')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(1);
      expect(docs[0]._id.toString()).toBe(multiDoc._id.toString());
    });

    it('should return empty results when category does not match despite other matching filters', async () => {
      const res = await request(app)
        .get('/documents/search?name=OmniFilter&owner=owner&category=legal&startDate=2026-04-01&endDate=2026-04-30')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(0);
    });

    it('should return empty results when date range does not match despite other matching filters', async () => {
      const res = await request(app)
        .get('/documents/search?name=OmniFilter&owner=owner&category=financial&startDate=2026-05-01&endDate=2026-05-31')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents || res.body.results;
      expect(docs.length).toBe(0);
    });
  });

  // =========================================================================
  // 7. DB-LEVEL FILTERING PROOF (NEVER FILTERED IN JS AFTER FETCHING)
  // =========================================================================
  describe('Verification of DB-Level Filtering Execution', () => {
    it('should construct MongoDB query with permission filter and search criteria at the database layer', async () => {
      const findSpy = jest.spyOn(Document, 'find');

      await request(app)
        .get('/documents/search?name=annual_budget&category=finance')
        .set('Cookie', viewerCookie);

      expect(findSpy).toHaveBeenCalled();
      const lastCallQuery = findSpy.mock.calls[findSpy.mock.calls.length - 1][0];

      // Verify permission clause is present in the database query object
      const queryString = JSON.stringify(lastCallQuery);
      expect(queryString).toContain('deletedAt');
      expect(queryString).toContain('$or');

      findSpy.mockRestore();
    });
  });
});
