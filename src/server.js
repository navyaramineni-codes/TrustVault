require('dotenv').config();
const app = require('./app');
const { connectDB, disconnectDB } = require('./config/db');

const PORT = process.env.PORT || 5000;

let server;

async function startServer() {
  try {
    await connectDB();
  } catch (error) {
    console.warn('[Server] Initial MongoDB connection failed. Running server in degraded state; will retry on subsequent operations.');
  }

  server = app.listen(PORT, () => {
    console.log(`[Server] TrustVault service listening on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  });
}

// Graceful shutdown handling
async function shutdown(signal) {
  console.log(`[Server] Received ${signal}. Commencing graceful shutdown...`);

  if (server) {
    server.close(async () => {
      console.log('[Server] HTTP server closed.');
      await disconnectDB();
      process.exit(0);
    });
  } else {
    await disconnectDB();
    process.exit(0);
  }

  // Force exit if graceful shutdown hangs
  setTimeout(() => {
    console.error('[Server] Graceful shutdown timed out. Forcing process termination.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
  process.exit(1);
});

startServer();
