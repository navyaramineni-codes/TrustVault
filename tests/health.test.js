const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const { connectDB, disconnectDB } = require('../src/config/db');

describe('Health Route & Core Security Baseline', () => {
  describe('GET /health (Offline / In-Memory State)', () => {
    it('should return 200 OK with operational status and services info', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('uptime');
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body).toHaveProperty('timestamp');
      expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
      expect(response.body).toHaveProperty('services');
      expect(response.body.services).toHaveProperty('database');
      expect(['connected', 'disconnected']).toContain(response.body.services.database);
    });

    it('should not leak X-Powered-By header', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('should include Helmet security headers', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    });
  });

  describe('GET /health (With Active Database Connection)', () => {
    beforeAll(async () => {
      try {
        await connectDB();
      } catch (err) {
        // Degraded mode if MongoDB is not running locally
      }
    });

    afterAll(async () => {
      await disconnectDB();
    });

    it('should report database as connected when Mongoose is connected', async () => {
      if (mongoose.connection.readyState === 1) {
        const response = await request(app).get('/health');
        expect(response.status).toBe(200);
        expect(response.body.services.database).toBe('connected');
      }
    });
  });

  describe('Undefined Routes', () => {
    it('should return 404 Not Found for non-existent routes', async () => {
      const response = await request(app).get('/non-existent-endpoint');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not Found' });
    });
  });
});
