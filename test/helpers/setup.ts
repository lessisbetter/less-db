/**
 * Shared test helpers for consistent database setup and teardown.
 */

import { LessDB } from "../../src/index.js";

/**
 * Standard user interface used across tests.
 */
export interface TestUser {
  id?: number;
  name: string;
  email: string;
  age: number;
}

/**
 * Standard setting interface used across tests.
 */
export interface TestSetting {
  key: string;
  value: unknown;
}

/**
 * Generate a unique database name for testing.
 */
export function generateDbName(prefix = "test-db"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Create a test database with common schema.
 * Includes users table (auto-increment id, indexed name, unique email, indexed age)
 * and settings table (primary key).
 */
export function createTestDB(name?: string): LessDB {
  const dbName = name ?? generateDbName();
  const db = new LessDB(dbName);
  db.version(1).stores({
    users: "++id, name, &email, age",
    settings: "key",
  });
  return db;
}

/**
 * Create a test database with custom schema.
 */
export function createTestDBWithSchema(stores: Record<string, string>, name?: string): LessDB {
  const dbName = name ?? generateDbName();
  const db = new LessDB(dbName);
  db.version(1).stores(stores);
  return db;
}

/**
 * Generate test users.
 */
export function createTestUsers(count: number): TestUser[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `User${i}`,
    email: `user${i}@test.com`,
    age: 20 + i,
  }));
}

/**
 * Clean up a database (close and delete).
 */
export async function cleanupDB(db: LessDB): Promise<void> {
  if (db.isOpen) {
    db.close();
  }
  try {
    await db.delete();
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Default schema for test databases.
 */
const DEFAULT_SCHEMA = {
  users: "++id, name, &email, age",
  settings: "key",
};

/**
 * Setup and teardown helper for tests.
 * Returns functions to use in beforeEach/afterEach.
 *
 * @param schema - Custom schema to use, or undefined for default schema
 */
export function useTestDB(schema?: Record<string, string>) {
  let db: LessDB;
  let dbName: string;

  const setup = () => {
    dbName = generateDbName();
    db = new LessDB(dbName);
    db.version(1).stores(schema ?? DEFAULT_SCHEMA);
    return db;
  };

  const teardown = async () => {
    await cleanupDB(db);
  };

  const getDB = () => db;
  const getDBName = () => dbName;

  return { setup, teardown, getDB, getDBName };
}
