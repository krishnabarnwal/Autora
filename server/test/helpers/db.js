import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Test harness: a real MongoDB server (in-process) so schema behaviour,
 * indexes, and unique constraints are exercised against the actual engine
 * rather than a mock.
 */

let server = null;

export async function startTestDb() {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('test_autonomous_ai_creator'));
  const { syncIndexes } = await import('../../src/models/index.js');
  await syncIndexes();
  return mongoose.connection;
}

export async function stopTestDb() {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  if (server) await server.stop();
  server = null;
}

/** Wipe all collections between tests without paying for index rebuilds. */
export async function clearTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
