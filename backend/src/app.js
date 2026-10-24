const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { doubleCsrfProtection } = require('./config/csrf');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');
const adminRoutes = require('./routes/admin');
const adminDashboardRoutes = require('./routes/adminDashboard');

const app = express();

// Trust reverse proxy for secure cookie flags when behind reverse proxy / load balancer
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Security middleware: disable Express signature and enforce HTTP headers
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Body parsing with safe size limit to mitigate DoS payload floods
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser(process.env.SESSION_SECRET || 'trustvault-dev-secret-key-change-in-prod-32bytes'));

// Session configuration with HttpOnly and SameSite cookie policies
const isTestEnv = process.env.NODE_ENV === 'test';
const sessionStore = isTestEnv
  ? undefined
  : MongoStore.create({
      mongoUrl: process.env.MONGODB_URI || 'mongodb://trustadmin:trustpassword@127.0.0.1:27017/trustvault?authSource=admin',
      collectionName: 'sessions',
      ttl: 24 * 60 * 60, // 1 day
    });

app.use(
  session({
    name: 'trustvault.sid',
    secret: process.env.SESSION_SECRET || 'trustvault-dev-secret-key-change-in-prod-32bytes',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true, // Prevents client-side scripts from accessing session token (mitigates XSS session hijacking)
      sameSite: 'lax', // Mitigates Cross-Site Request Forgery (CSRF)
      secure: process.env.NODE_ENV === 'production', // Requires HTTPS in production
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      path: '/',
    },
  })
);

// Double-submit CSRF protection using csrf-csrf
app.use(doubleCsrfProtection);

// Route mounting
app.use('/health', healthRoutes);
app.use('/auth', authRoutes);
app.use('/api/auth', authRoutes);
app.use('/documents', documentRoutes);
app.use('/api/documents', documentRoutes);
app.use('/admin/users', adminRoutes);
app.use('/api/admin/users', adminRoutes);
app.use('/users', adminRoutes);
app.use('/api/users', adminRoutes);
app.use('/admin', adminDashboardRoutes);
app.use('/api/admin', adminDashboardRoutes);

// Production Static Client Serving & SPA Routing Fallback
const clientDistPath = path.resolve(__dirname, '../../client/dist');
if (process.env.NODE_ENV !== 'test' && fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    // If request accepts HTML and is not an API route, serve the React app
    if (
      req.accepts('html') &&
      !req.path.startsWith('/api') &&
      !req.path.startsWith('/health') &&
      !req.path.startsWith('/documents/download')
    ) {
      return res.sendFile(path.join(clientDistPath, 'index.html'));
    }
    next();
  });
}

// 404 handler for undefined endpoints
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Centralized error handler preventing stack trace disclosure
app.use((err, req, res, next) => {
  // Catch CSRF validation errors
  if (err.code === 'EBADCSRFTOKEN' || err.status === 403 || err.statusCode === 403 || (err.message && err.message.toLowerCase().includes('csrf'))) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = statusCode === 500 ? 'Internal Server Error' : err.message;

  if (statusCode === 500 && process.env.NODE_ENV !== 'test') {
    console.error('[App Error]', err);
  }

  res.status(statusCode).json({
    error: message,
  });
});

module.exports = app;
