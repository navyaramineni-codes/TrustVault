const request = require('supertest');
const mongoose = require('mongoose');
const { verify } = require('@node-rs/argon2');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');

describe('Admin-Only User Management Routes', () => {
  let adminCookie;
  let userCookie;
  let adminUser;
  let standardUser;

  beforeAll(async () => {
    await connectDB();
    await seedDatabase();

    // Retrieve seeded admin and user accounts
    adminUser = await User.findOne({ email: 'admin@trustvault.local' });
    standardUser = await User.findOne({ email: 'owner@trustvault.local' });

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
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // =========================================================================
  // 1. ACCESS CONTROL: Non-admins get 404 (Rule 3: never 403)
  // =========================================================================
  describe('Admin Authorization Gate (Non-Admins Get 404)', () => {
    it('should return 404 for unauthenticated requests to create user', async () => {
      const res = await request(app)
        .post('/admin/users')
        .send({
          email: 'unauth-create@trustvault.local',
          password: 'Password123!',
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for non-admin user attempting to create user', async () => {
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', userCookie)
        .send({
          email: 'nonadmin-create@trustvault.local',
          password: 'Password123!',
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for unauthenticated requests to change a user role', async () => {
      const res = await request(app)
        .patch(`/admin/users/${standardUser._id}/role`)
        .send({ role: 'admin' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for non-admin user attempting to change a user role', async () => {
      const res = await request(app)
        .patch(`/admin/users/${standardUser._id}/role`)
        .set('Cookie', userCookie)
        .send({ role: 'admin' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for unauthenticated requests to disable a user', async () => {
      const res = await request(app)
        .post(`/admin/users/${standardUser._id}/disable`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for non-admin user attempting to disable a user', async () => {
      const res = await request(app)
        .post(`/admin/users/${standardUser._id}/disable`)
        .set('Cookie', userCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for deactivated admin user', async () => {
      const tempPass = 'DeactivatedAdmin2026!';
      const tempHash = await require('@node-rs/argon2').hash(tempPass);
      const tempAdmin = await User.create({
        email: `deact-admin-${Date.now()}@trustvault.local`,
        passwordHash: tempHash,
        role: 'admin',
        isActive: true,
      });

      // Login to establish session
      const loginRes = await request(app)
        .post('/auth/login')
        .send({ email: tempAdmin.email, password: tempPass });
      const deactAdminCookie = loginRes.headers['set-cookie'];

      // Deactivate the admin user
      tempAdmin.isActive = false;
      await tempAdmin.save();

      // Deactivated admin attempting admin action must return 404
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', deactAdminCookie)
        .send({ email: 'test@trustvault.local', password: 'Password123!' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });

    it('should return 404 for non-admin user attempting to list users', async () => {
      const res = await request(app)
        .get('/admin/users')
        .set('Cookie', userCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });
  });

  // =========================================================================
  // 2. ROUTE: LIST USERS (GET /admin/users)
  // =========================================================================
  describe('GET /admin/users (List Users)', () => {
    it('should allow admin to list all registered users excluding password hashes', async () => {
      const res = await request(app)
        .get('/admin/users')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('users');
      expect(Array.isArray(res.body.users)).toBe(true);
      expect(res.body.users.length).toBeGreaterThan(0);
      for (const u of res.body.users) {
        expect(u).toHaveProperty('email');
        expect(u).toHaveProperty('role');
        expect(u).toHaveProperty('isActive');
        expect(u.passwordHash).toBeUndefined();
      }
    });
  });

  // =========================================================================
  // 3. ROUTE: CREATE USER (POST /admin/users)
  // =========================================================================
  describe('POST /admin/users (Create User)', () => {
    it('should allow admin to create a new user with default role "user" and hashed password', async () => {
      const email = `new-employee-${Date.now()}@trustvault.local`;
      const plainPassword = 'EmployeeVault2026!';

      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email,
          password: plainPassword,
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('message', 'User created successfully');
      expect(res.body).toHaveProperty('user');
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.role).toBe('user');
      expect(res.body.user.isActive).toBe(true);
      expect(res.body.user.passwordHash).toBeUndefined();

      // Verify in MongoDB
      const dbUser = await User.findOne({ email }).select('+passwordHash');
      expect(dbUser).not.toBeNull();
      expect(dbUser.role).toBe('user');
      expect(dbUser.isActive).toBe(true);

      // Verify Argon2 password hashing
      const isValid = await verify(dbUser.passwordHash, plainPassword);
      expect(isValid).toBe(true);
    });

    it('should allow admin to create a new user with explicit role "admin"', async () => {
      const email = `new-admin-${Date.now()}@trustvault.local`;
      const plainPassword = 'NewAdminPass2026!';

      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email,
          password: plainPassword,
          role: 'admin',
        });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.role).toBe('admin');

      const dbUser = await User.findOne({ email });
      expect(dbUser.role).toBe('admin');
    });

    it('should reject request missing email or password with 400', async () => {
      const resMissingPass = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({ email: 'nopass@trustvault.local' });
      expect(resMissingPass.status).toBe(400);

      const resMissingEmail = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({ password: 'ValidPassword123!' });
      expect(resMissingEmail.status).toBe(400);
    });

    it('should reject invalid email format with 400', async () => {
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: 'not-an-email',
          password: 'ValidPassword123!',
        });
      expect(res.status).toBe(400);
    });

    it('should reject invalid role with 400', async () => {
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: 'invalid-role@trustvault.local',
          password: 'ValidPassword123!',
          role: 'superadmin',
        });
      expect(res.status).toBe(400);
    });

    it('should reject duplicate email with 409 or 400', async () => {
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: 'admin@trustvault.local', // Already seeded
          password: 'ValidPassword123!',
        });
      expect([400, 409]).toContain(res.status);
    });
  });

  // =========================================================================
  // 3. ROUTE: CHANGE USER ROLE (PATCH /admin/users/:id/role)
  // =========================================================================
  describe('PATCH /admin/users/:id/role (Change User Role)', () => {
    let targetUser;

    beforeEach(async () => {
      targetUser = await User.create({
        email: `role-test-${Date.now()}@trustvault.local`,
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$placeholderhash',
        role: 'user',
        isActive: true,
      });
    });

    it('should allow admin to change user role from "user" to "admin"', async () => {
      const res = await request(app)
        .patch(`/admin/users/${targetUser._id}/role`)
        .set('Cookie', adminCookie)
        .send({ role: 'admin' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', 'User role updated successfully');
      expect(res.body.user.role).toBe('admin');

      const updatedDbUser = await User.findById(targetUser._id);
      expect(updatedDbUser.role).toBe('admin');
    });

    it('should allow admin to demote user role from "admin" to "user"', async () => {
      targetUser.role = 'admin';
      await targetUser.save();

      const res = await request(app)
        .patch(`/admin/users/${targetUser._id}/role`)
        .set('Cookie', adminCookie)
        .send({ role: 'user' });

      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('user');

      const updatedDbUser = await User.findById(targetUser._id);
      expect(updatedDbUser.role).toBe('user');
    });

    it('should reject invalid role with 400', async () => {
      const res = await request(app)
        .patch(`/admin/users/${targetUser._id}/role`)
        .set('Cookie', adminCookie)
        .send({ role: 'unauthorized_role' });

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent user ID', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .patch(`/admin/users/${nonExistentId}/role`)
        .set('Cookie', adminCookie)
        .send({ role: 'admin' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });
  });

  // =========================================================================
  // 4. ROUTE: DISABLE USER & IMMEDIATELY TERMINATE ACTIVE SESSIONS
  // =========================================================================
  describe('POST /admin/users/:id/disable (Disable User & Immediate Session Revocation)', () => {
    it('should disable a user and immediately invalidate all active sessions', async () => {
      // Step 1: Create a dedicated user for this test
      const testEmail = `victim-session-${Date.now()}@trustvault.local`;
      const plainPass = 'VictimSession2026!';
      const createRes = await request(app)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: testEmail,
          password: plainPass,
          role: 'user',
        });
      const victimUser = createRes.body.user;

      // Step 2: Victim logs in from Session 1 (e.g. Laptop)
      const login1Res = await request(app)
        .post('/auth/login')
        .send({ email: testEmail, password: plainPass });
      expect(login1Res.status).toBe(200);
      const session1Cookie = login1Res.headers['set-cookie'];

      // Step 3: Victim logs in from Session 2 (e.g. Mobile device)
      const login2Res = await request(app)
        .post('/auth/login')
        .send({ email: testEmail, password: plainPass });
      expect(login2Res.status).toBe(200);
      const session2Cookie = login2Res.headers['set-cookie'];

      // Step 4: Verify both sessions are currently active
      const me1Before = await request(app)
        .get('/auth/me')
        .set('Cookie', session1Cookie);
      expect(me1Before.status).toBe(200);

      const me2Before = await request(app)
        .get('/auth/me')
        .set('Cookie', session2Cookie);
      expect(me2Before.status).toBe(200);

      // Step 5: Admin disables the user
      const disableRes = await request(app)
        .post(`/admin/users/${victimUser._id}/disable`)
        .set('Cookie', adminCookie);

      expect(disableRes.status).toBe(200);
      expect(disableRes.body).toHaveProperty('message', 'User disabled successfully');
      expect(disableRes.body.user.isActive).toBe(false);

      // Verify database state
      const dbVictim = await User.findById(victimUser._id);
      expect(dbVictim.isActive).toBe(false);

      // Step 6: Verify BOTH active sessions are immediately ended (returns 401)
      const me1After = await request(app)
        .get('/auth/me')
        .set('Cookie', session1Cookie);
      expect(me1After.status).toBe(401);

      const me2After = await request(app)
        .get('/auth/me')
        .set('Cookie', session2Cookie);
      expect(me2After.status).toBe(401);

      // Step 7: Attempting document access with terminated session returns 401
      const docAccess = await request(app)
        .get('/documents')
        .set('Cookie', session1Cookie);
      expect(docAccess.status).toBe(401);

      // Step 8: Subsequent login attempt is rejected
      const loginAttempt = await request(app)
        .post('/auth/login')
        .send({ email: testEmail, password: plainPass });
      expect(loginAttempt.status).toBe(401);
      expect(loginAttempt.body).toEqual({ error: 'Account is deactivated' });
    });

    it('should return 404 when disabling a non-existent user ID', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/admin/users/${nonExistentId}/disable`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not Found' });
    });
  });

  // =========================================================================
  // 5. API ROUTE ALIASES (/api/admin/users)
  // =========================================================================
  describe('API Route Parity (/api/admin/users)', () => {
    it('should support /api/admin/users for user creation', async () => {
      const res = await request(app)
        .post('/api/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: `alias-${Date.now()}@trustvault.local`,
          password: 'AliasPassword2026!',
        });

      expect(res.status).toBe(201);
    });
  });
});
