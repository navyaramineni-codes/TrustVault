const request = require('supertest');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User, AuditEvent } = require('../src/models');
const { seedDatabase } = require('../scripts/seed');

describe('Authentication & Session Management (Argon2, HttpOnly, SameSite, Audit)', () => {
  beforeAll(async () => {
    await connectDB();
    await seedDatabase();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  describe('POST /auth/login', () => {
    it('should authenticate valid credentials, return user profile without passwordHash, and set HttpOnly SameSite cookie', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({
          email: 'owner@trustvault.local',
          password: 'OwnerVault2026!',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Login successful');
      expect(response.body.user).toHaveProperty('email', 'owner@trustvault.local');
      expect(response.body.user).toHaveProperty('role', 'user');
      expect(response.body.user.passwordHash).toBeUndefined();

      // Verify Set-Cookie header attributes
      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const sessionCookie = cookies.find((c) => c.startsWith('trustvault.sid='));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'USER_LOGIN',
        userId: response.body.user._id,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('SUCCESS');
      expect(auditLog.action).toBe('login');
    });

    it('should reject invalid password with 401 and log denied audit event', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({
          email: 'owner@trustvault.local',
          password: 'WrongPassword123!',
        });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid email or password' });

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'AUTH_FAILED',
        reason: 'Invalid email or password',
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
      expect(auditLog.action).toBe('login');
    });

    it('should reject non-existent user with 401 and generic message to prevent user enumeration', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({
          email: 'nonexistent@trustvault.local',
          password: 'AnyPassword123!',
        });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid email or password' });

      const auditLog = await AuditEvent.findOne({
        eventType: 'AUTH_FAILED',
        'metadata.attemptedEmail': 'nonexistent@trustvault.local',
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('DENIED');
    });

    it('should reject requests missing email or password with 400', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'owner@trustvault.local' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Email and password are required' });
    });
  });

  describe('GET /auth/me & Session Verification', () => {
    it('should return 401 when accessing /auth/me unauthenticated', async () => {
      const response = await request(app).get('/auth/me');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 200 and user data when accessing /auth/me with valid session cookie', async () => {
      // Step 1: Login to obtain session cookie
      const loginRes = await request(app)
        .post('/auth/login')
        .send({
          email: 'viewer@trustvault.local',
          password: 'ViewerVault2026!',
        });

      const sessionCookie = loginRes.headers['set-cookie'];

      // Step 2: Use session cookie to access /auth/me
      const meRes = await request(app)
        .get('/auth/me')
        .set('Cookie', sessionCookie);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user).toHaveProperty('email', 'viewer@trustvault.local');
      expect(meRes.body.user).toHaveProperty('role', 'user');
      expect(meRes.body.user.passwordHash).toBeUndefined();
    });
  });

  describe('POST /auth/logout', () => {
    it('should destroy session, clear cookie, and record logout audit event', async () => {
      // Step 1: Login
      const loginRes = await request(app)
        .post('/auth/login')
        .send({
          email: 'admin@trustvault.local',
          password: 'AdminVault2026!',
        });

      const sessionCookie = loginRes.headers['set-cookie'];
      const userId = loginRes.body.user._id;

      // Step 2: Logout
      const logoutRes = await request(app)
        .post('/auth/logout')
        .set('Cookie', sessionCookie);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body).toEqual({ message: 'Logout successful' });

      // Verify Set-Cookie clears trustvault.sid
      const logoutCookies = logoutRes.headers['set-cookie'];
      expect(logoutCookies).toBeDefined();
      const clearedCookie = logoutCookies.find((c) => c.startsWith('trustvault.sid=;'));
      expect(clearedCookie).toBeDefined();

      // Step 3: Verify session is destroyed by accessing /auth/me with old cookie
      const meRes = await request(app)
        .get('/auth/me')
        .set('Cookie', sessionCookie);

      expect(meRes.status).toBe(401);

      // Verify AuditEvent write
      const auditLog = await AuditEvent.findOne({
        eventType: 'USER_LOGOUT',
        userId: userId,
      }).sort({ timestamp: -1 });

      expect(auditLog).toBeDefined();
      expect(auditLog.status).toBe('SUCCESS');
      expect(auditLog.action).toBe('logout');
    });
  });

  describe('API alias route parity (/api/auth)', () => {
    it('should support /api/auth/login and /api/auth/logout with identical security', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@trustvault.local',
          password: 'AdminVault2026!',
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.headers['set-cookie'][0]).toMatch(/HttpOnly/i);

      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', loginRes.headers['set-cookie']);

      expect(logoutRes.status).toBe(200);
    });
  });
});
