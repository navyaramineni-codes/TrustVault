const express = require('express');
const helmet = require('helmet');
const healthRoutes = require('./routes/health');

const app = express();

// Security middleware: disable Express signature and set security headers
app.disable('x-powered-by');
app.use(helmet());

// Body parsing with safe size limit to mitigate DoS payload floods
app.use(express.json({ limit: '10kb' }));

// Health check route
app.use('/health', healthRoutes);

// 404 handler for undefined endpoints
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Centralized error handler preventing stack trace disclosure
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 ? 'Internal Server Error' : err.message;

  res.status(statusCode).json({
    error: message,
  });
});

module.exports = app;
