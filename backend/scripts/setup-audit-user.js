require('dotenv').config();
const { connectDB, disconnectDB } = require('../src/config/db');
const { setupAuditAppUser } = require('../src/audit');

async function main() {
  console.log('[Setup] Connecting to MongoDB to configure audit app user...');
  const conn = await connectDB();

  try {
    const config = await setupAuditAppUser(conn.connection);
    console.log(`[Setup] Successfully configured MongoDB app user: ${config.username} (Role: ${config.role})`);
    console.log(`[Setup] Granted privileges: [insert, find] on collection "auditevents"`);
  } catch (error) {
    console.error('[Setup] Failed to configure audit app user:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    await disconnectDB();
  }
}

if (require.main === module) {
  main().then(() => {
    process.exit(process.exitCode || 0);
  });
}

module.exports = {
  main,
};
