require('dotenv').config();
const mongoose = require('mongoose');

/**
 * Connects to MongoDB using Mongoose.
 * @param {string} [customUri] - Optional custom MongoDB URI (useful for testing or overrides)
 * @returns {Promise<typeof mongoose>}
 */
async function connectDB(customUri) {
  const uri = customUri || process.env.MONGODB_URI || 'mongodb://trustadmin:trustpassword@127.0.0.1:27017/trustvault?authSource=admin';

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });

    // Sanitize connection URI to avoid logging credentials
    const host = conn.connection.host;
    const port = conn.connection.port;
    const name = conn.connection.name;
    console.log(`[Database] MongoDB connected successfully to ${host}:${port}/${name}`);
    return conn;
  } catch (error) {
    console.error(`[Database] Connection error: ${error.message}`);
    throw error;
  }
}

/**
 * Disconnects from MongoDB gracefully.
 * @returns {Promise<void>}
 */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log('[Database] MongoDB disconnected');
  }
}

module.exports = {
  connectDB,
  disconnectDB,
};
