const mongoose = require('mongoose');
const { User, Document, Permission, AuditEvent } = require('../src/models');
const { connectDB, disconnectDB } = require('../src/config/db');

describe('Mongoose Data Models Validation & Security Constraints', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    // Clean up test collections and disconnect
    if (mongoose.connection.readyState === 1) {
      await User.deleteMany({ email: /@test\.com$/ });
      await Document.deleteMany({ title: /^Test Doc/ });
      await Permission.deleteMany({});
      await AuditEvent.deleteMany({ eventType: /^TEST_/ });
    }
    await disconnectDB();
  });

  describe('User Model', () => {
    it('should validate required fields and reject missing email or passwordHash', () => {
      const user = new User({});
      const error = user.validateSync();

      expect(error.errors.email).toBeDefined();
      expect(error.errors.passwordHash).toBeDefined();
    });

    it('should normalize email to lowercase and reject invalid email formats', () => {
      const user = new User({
        email: '   ALICE@TEST.COM   ',
        passwordHash: 'hashed_pw_123',
      });

      expect(user.email).toBe('alice@test.com');

      const invalidUser = new User({
        email: 'not-an-email',
        passwordHash: 'hashed_pw_123',
      });
      const error = invalidUser.validateSync();
      expect(error.errors.email).toBeDefined();
    });

    it('should set default role to "user" and reject unauthorized roles', () => {
      const user = new User({
        email: 'bob@test.com',
        passwordHash: 'hashed_pw_123',
      });
      expect(user.role).toBe('user');

      user.role = 'superadmin';
      const error = user.validateSync();
      expect(error.errors.role).toBeDefined();
    });

    it('should omit passwordHash from toJSON output', () => {
      const user = new User({
        email: 'charlie@test.com',
        passwordHash: 'secret_hash_value',
      });
      const json = user.toJSON();

      expect(json.email).toBe('charlie@test.com');
      expect(json.passwordHash).toBeUndefined();
    });
  });

  describe('Document Model', () => {
    it('should require title, fileStorageName, originalFileName, mimeType, sizeBytes, and ownerId', () => {
      const doc = new Document({});
      const error = doc.validateSync();

      expect(error.errors.title).toBeDefined();
      expect(error.errors.fileStorageName).toBeDefined();
      expect(error.errors.originalFileName).toBeDefined();
      expect(error.errors.mimeType).toBeDefined();
      expect(error.errors.sizeBytes).toBeDefined();
      expect(error.errors.ownerId).toBeDefined();
    });

    it('should reject negative file sizes', () => {
      const doc = new Document({
        title: 'Test Doc 1',
        fileStorageName: 'uuid-1234',
        originalFileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: -10,
        ownerId: new mongoose.Types.ObjectId(),
      });
      const error = doc.validateSync();
      expect(error.errors.sizeBytes).toBeDefined();
    });
  });

  describe('Permission Model', () => {
    it('should validate required fields', () => {
      const permission = new Permission({});
      const error = permission.validateSync();

      expect(error.errors.documentId).toBeDefined();
      expect(error.errors.userId).toBeDefined();
      expect(error.errors.level).toBeDefined();
      expect(error.errors.grantedBy).toBeDefined();
    });

    it('should accept only "read" or "edit" as permission levels', () => {
      const validRead = new Permission({
        documentId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        level: 'read',
        grantedBy: new mongoose.Types.ObjectId(),
      });
      expect(validRead.validateSync()).toBeUndefined();

      const validEdit = new Permission({
        documentId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        level: 'edit',
        grantedBy: new mongoose.Types.ObjectId(),
      });
      expect(validEdit.validateSync()).toBeUndefined();

      const invalidDelete = new Permission({
        documentId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        level: 'delete', // Rule 5: Viewers never have delete level
        grantedBy: new mongoose.Types.ObjectId(),
      });
      const error = invalidDelete.validateSync();
      expect(error.errors.level).toBeDefined();
    });

    it('should enforce unique compound index for (documentId, userId)', async () => {
      const docId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();
      const granterId = new mongoose.Types.ObjectId();

      await Permission.init(); // Ensure indexes are built in Mongo

      await Permission.create({
        documentId: docId,
        userId: userId,
        level: 'read',
        grantedBy: granterId,
      });

      // Attempt duplicate permission grant for same user and document
      await expect(
        Permission.create({
          documentId: docId,
          userId: userId,
          level: 'edit',
          grantedBy: granterId,
        })
      ).rejects.toThrow();
    });
  });

  describe('AuditEvent Model', () => {
    it('should require eventType, action, and valid status', () => {
      const event = new AuditEvent({});
      const error = event.validateSync();

      expect(error.errors.eventType).toBeDefined();
      expect(error.errors.action).toBeDefined();
      expect(error.errors.status).toBeDefined();
    });

    it('should accept valid statuses (SUCCESS, DENIED, FAILURE) and reject others', () => {
      const validEvent = new AuditEvent({
        eventType: 'TEST_ACCESS',
        action: 'read',
        status: 'DENIED',
      });
      expect(validEvent.validateSync()).toBeUndefined();

      const invalidEvent = new AuditEvent({
        eventType: 'TEST_ACCESS',
        action: 'read',
        status: 'UNKNOWN_STATUS',
      });
      const error = invalidEvent.validateSync();
      expect(error.errors.status).toBeDefined();
    });

    it('should block updates to enforce immutability of audit logs', async () => {
      const event = await AuditEvent.create({
        eventType: 'TEST_IMMUTABLE',
        action: 'edit',
        status: 'SUCCESS',
      });

      // Block instance save updates
      event.action = 'modified_action';
      await expect(event.save()).rejects.toThrow(/immutable/i);

      // Block query-level updateOne
      await expect(
        AuditEvent.updateOne({ _id: event._id }, { action: 'tampered_action' })
      ).rejects.toThrow(/immutable/i);

      // Block findOneAndUpdate
      await expect(
        AuditEvent.findOneAndUpdate({ _id: event._id }, { action: 'tampered_action' })
      ).rejects.toThrow(/immutable/i);
    });
  });
});
