require('dotenv').config();
const { hash } = require('@node-rs/argon2');
const { connectDB, disconnectDB } = require('../src/config/db');
const { User } = require('../src/models');
const { logAuditEvent } = require('../src/audit');

const SEED_USERS = [
  {
    email: 'admin@trustvault.local',
    password: process.env.SEED_ADMIN_PASSWORD || 'AdminVault2026!',
    role: 'admin',
    description: 'Platform administrator (no automatic access to document contents per Rule 5)',
  },
  {
    email: 'owner@trustvault.local',
    password: process.env.SEED_OWNER_PASSWORD || 'OwnerVault2026!',
    role: 'user',
    description: 'Document owner (can create, edit, delete, and grant permissions per Rule 5)',
  },
  {
    email: 'viewer@trustvault.local',
    password: process.env.SEED_VIEWER_PASSWORD || 'ViewerVault2026!',
    role: 'user',
    description: 'Document viewer (read/edit only when explicitly granted per Rule 5)',
  },
];

async function seedDatabase(shouldDisconnect = false) {
  console.log('[Seed] Starting TrustVault database seeding...');

  try {
    await connectDB();

    for (const seedUser of SEED_USERS) {
      const passwordHash = await hash(seedUser.password);

      const user = await User.findOneAndUpdate(
        { email: seedUser.email },
        {
          email: seedUser.email,
          passwordHash: passwordHash,
          role: seedUser.role,
          isActive: true,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log(`[Seed] Seeded user: ${user.email} (Role: ${user.role}, ID: ${user._id})`);

      await logAuditEvent({
        eventType: 'USER_SEEDED',
        userId: user._id,
        action: 'seed',
        status: 'SUCCESS',
        metadata: {
          email: user.email,
          role: user.role,
        },
      });
    }

    // Configure MongoDB audit app user with least privilege (insert & find only)
    const { setupAuditAppUser } = require('../src/audit');
    await setupAuditAppUser();
    console.log('[Seed] Configured MongoDB app user with insert and find privileges on auditevents');

    console.log('[Seed] Database seeding completed successfully.');
  } catch (error) {
    console.error('[Seed] Database seeding failed:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (shouldDisconnect) {
      await disconnectDB();
    }
  }
}

if (require.main === module) {
  seedDatabase(true).then(() => {
    process.exit(process.exitCode || 0);
  });
}

module.exports = {
  SEED_USERS,
  seedDatabase,
};
