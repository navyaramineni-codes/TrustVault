const { doubleCsrf } = require('csrf-csrf');

const CSRF_SECRET = process.env.CSRF_SECRET || 'trustvault-csrf-secret-key-must-be-long-and-secure-32chars';

const {
  invalidCsrfTokenError,
  generateCsrfToken,
  validateRequest,
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => CSRF_SECRET,
  cookieName: 'trustvault.x-csrf-token',
  cookieOptions: {
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false, // Must be accessible to client-side scripts to read and include in header
  },
  size: 32,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getSessionIdentifier: (req) => (req.session && req.session.userId ? req.session.userId.toString() : 'anonymous'),
  getCsrfTokenFromRequest: (req) =>
    req.headers['x-csrf-token'] ||
    req.headers['x-xsrf-token'] ||
    req.body?._csrf,
  skipCsrfProtection: (req) => {
    // In test environment, skip unless test explicitly requests CSRF enforcement via x-test-csrf header
    if (process.env.NODE_ENV === 'test') {
      return !req.headers['x-test-csrf'];
    }
    return false;
  },
});

module.exports = {
  invalidCsrfTokenError,
  generateCsrfToken,
  validateRequest,
  doubleCsrfProtection,
};
