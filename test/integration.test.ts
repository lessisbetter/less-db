/**
 * Integration tests for real-world scenarios and edge cases.
 *
 * These tests are designed to catch subtle bugs that unit tests might miss.
 * They focus on:
 * - Transaction lifecycle edge cases (the #1 source of production bugs)
 * - JavaScript type edge cases (falsy values, undefined, TypedArrays)
 * - Error propagation semantics (promise rejection vs sync throw)
 * - High-volume operations that behave differently at scale
 *
 * Based on analysis of Dexie.js test suite and common real-world issues.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LessDB,
  ConstraintError,
  InvalidTableError,
  NotFoundError,
  DataError,
  LessDBPromise,
} from "../src/index.js";
import { generateDbName, cleanupDB } from "./helpers/setup.js";

// ============================================================================
// Test Interfaces
// ============================================================================

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
}

interface Setting {
  key: string | number;
  value: unknown;
}

interface Item {
  id?: number;
  data: unknown;
}

// ============================================================================
// Transaction Edge Cases
// ============================================================================

describe("transaction edge cases", () => {
  let db: LessDB;

  beforeEach(() => {
    db = new LessDB(generateDbName("tx-edge"));
    db.version(1).stores({
      users: "++id, name, &email",
      settings: "key",
      items: "++id",
    });
  });

  afterEach(async () => {
    await cleanupDB(db);
  });

  describe("table scope enforcement", () => {
    it("throws when accessing table not in transaction scope", async () => {
      await db.open();

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          // Try to access settings table which is not in the transaction
          tx.table("settings");
        }),
      ).rejects.toThrow(InvalidTableError);
    });

    it("throws when accessing table not in transaction scope (write)", async () => {
      await db.open();
      await db.table<Setting, string>("settings").add({ key: "test", value: 1 });

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          // Try to write to settings table which is not in the transaction
          await tx.table<Setting, string>("settings").add({ key: "x", value: 1 });
        }),
      ).rejects.toThrow(InvalidTableError);
    });
  });

  describe("read-only transaction enforcement", () => {
    it("fails when writing in read-only transaction", async () => {
      await db.open();

      await expect(
        db.transaction("r", ["users"], async (tx) => {
          await tx.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
        }),
      ).rejects.toThrow();
    });

    it("allows reads in read-only transaction", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com" });

      const result = await db.transaction("r", ["users"], async (tx) => {
        return tx.table<User, number>("users").toArray();
      });

      expect(result).toHaveLength(1);
    });
  });

  describe("transaction rollback", () => {
    it("rolls back all writes when transaction fails", async () => {
      await db.open();

      // Transaction should fail due to constraint error
      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          const users = tx.table<User, number>("users");
          await users.add({ name: "Alice", email: "shared@test.com" });
          await users.add({ name: "Bob", email: "shared@test.com" }); // Duplicate email
        }),
      ).rejects.toThrow(ConstraintError);

      // Alice should NOT exist - transaction was rolled back
      const count = await db.table<User, number>("users").count();
      expect(count).toBe(0);
    });

    it("rolls back writes when user code throws", async () => {
      await db.open();

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          await tx.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
          throw new Error("User code error");
        }),
      ).rejects.toThrow("User code error");

      // Alice should NOT exist - transaction was rolled back
      const count = await db.table<User, number>("users").count();
      expect(count).toBe(0);
    });

    it("rolls back writes when abort() is called", async () => {
      await db.open();

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          await tx.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
          tx.abort();
          // Continue trying to add after abort
          await tx.table<User, number>("users").add({ name: "Bob", email: "b@test.com" });
        }),
      ).rejects.toThrow();

      // Neither user should exist
      const count = await db.table<User, number>("users").count();
      expect(count).toBe(0);
    });
  });

  describe("empty transaction blocks", () => {
    it("handles empty transaction block", async () => {
      await db.open();

      // Transaction that doesn't do anything should complete without error
      await expect(
        db.transaction("rw", ["users"], async () => {
          // Empty - no operations
        }),
      ).resolves.toBeUndefined();
    });

    it("handles transaction with only reads", async () => {
      await db.open();

      const result = await db.transaction("r", ["users"], async (tx) => {
        return tx.table<User, number>("users").count();
      });

      expect(result).toBe(0);
    });
  });

  describe("transaction state", () => {
    it("reports active state correctly", async () => {
      await db.open();
      let wasActive = false;

      await db.transaction("rw", ["users"], async (tx) => {
        wasActive = tx.active;
        await tx.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
      });

      expect(wasActive).toBe(true);
    });

    it("reports mode correctly", async () => {
      await db.open();
      let readMode: string | undefined;
      let writeMode: string | undefined;

      await db.transaction("r", ["users"], async (tx) => {
        readMode = tx.mode;
      });

      await db.transaction("rw", ["users"], async (tx) => {
        writeMode = tx.mode;
      });

      expect(readMode).toBe("readonly");
      expect(writeMode).toBe("readwrite");
    });

    it("reports tables correctly", async () => {
      await db.open();
      let tables: string[] = [];

      await db.transaction("rw", ["users", "settings"], async (tx) => {
        tables = tx.tables;
      });

      expect(tables).toContain("users");
      expect(tables).toContain("settings");
    });
  });
});

// ============================================================================
// Data Type Edge Cases
// ============================================================================

describe("data type edge cases", () => {
  let db: LessDB;

  beforeEach(() => {
    db = new LessDB(generateDbName("type-edge"));
  });

  afterEach(async () => {
    await cleanupDB(db);
  });

  describe("falsy key values", () => {
    it("handles numeric key 0", async () => {
      db.version(1).stores({ settings: "key" });
      await db.open();

      const settings = db.table<Setting, number>("settings");
      await settings.add({ key: 0, value: "zero" });

      const result = await settings.get(0);
      expect(result).toEqual({ key: 0, value: "zero" });
    });

    it("handles empty string key", async () => {
      db.version(1).stores({ settings: "key" });
      await db.open();

      const settings = db.table<Setting, string>("settings");
      await settings.add({ key: "", value: "empty" });

      const result = await settings.get("");
      expect(result).toEqual({ key: "", value: "empty" });
    });

    it("put works with falsy keys", async () => {
      db.version(1).stores({ settings: "key" });
      await db.open();

      const settings = db.table<Setting, number>("settings");
      await settings.put({ key: 0, value: "initial" });
      await settings.put({ key: 0, value: "updated" });

      const result = await settings.get(0);
      expect(result?.value).toBe("updated");
    });

    it("delete works with falsy keys", async () => {
      db.version(1).stores({ settings: "key" });
      await db.open();

      const settings = db.table<Setting, number>("settings");
      await settings.add({ key: 0, value: "zero" });
      await settings.delete(0);

      const result = await settings.get(0);
      expect(result).toBeUndefined();
    });

    it("where().equals() works with falsy keys", async () => {
      db.version(1).stores({ settings: "key" });
      await db.open();

      const settings = db.table<Setting, number>("settings");
      await settings.add({ key: 0, value: "zero" });
      await settings.add({ key: 1, value: "one" });

      const results = await settings.where("key").equals(0).toArray();
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe("zero");
    });
  });

  describe("undefined vs missing primary key", () => {
    it("auto-increment works without id property", async () => {
      db.version(1).stores({ users: "++id, name" });
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com" });

      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("auto-increment works with explicit undefined id", async () => {
      db.version(1).stores({ users: "++id, name" });
      await db.open();

      const users = db.table<User, number>("users");
      // Explicitly set id to undefined - should still auto-increment
      const id = await users.add({ id: undefined, name: "Alice", email: "a@test.com" });

      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("can put back an auto-incremented item", async () => {
      db.version(1).stores({ users: "++id, name" });
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com" });

      const user = await users.get(id);
      expect(user).toBeDefined();

      user!.name = "Alice Updated";
      await users.put(user!);

      const updated = await users.get(id);
      expect(updated?.name).toBe("Alice Updated");
      expect(updated?.id).toBe(id); // Same ID preserved
    });
  });

  describe("complex data types", () => {
    it("stores and retrieves Date objects", async () => {
      db.version(1).stores({ items: "++id" });
      await db.open();

      const items = db.table<{ id?: number; date: Date }, number>("items");
      const testDate = new Date("2024-01-15T10:30:00Z");
      const id = await items.add({ date: testDate });

      const result = await items.get(id);
      expect(result?.date).toEqual(testDate);
    });

    it("stores and retrieves arrays", async () => {
      db.version(1).stores({ items: "++id" });
      await db.open();

      const items = db.table<{ id?: number; tags: string[] }, number>("items");
      const id = await items.add({ tags: ["a", "b", "c"] });

      const result = await items.get(id);
      expect(result?.tags).toEqual(["a", "b", "c"]);
    });

    it("stores and retrieves nested objects", async () => {
      db.version(1).stores({ items: "++id" });
      await db.open();

      const items = db.table<{ id?: number; meta: { nested: { value: number } } }, number>("items");
      const id = await items.add({ meta: { nested: { value: 42 } } });

      const result = await items.get(id);
      expect(result?.meta.nested.value).toBe(42);
    });

    it("stores and retrieves ArrayBuffer", async () => {
      db.version(1).stores({ items: "++id" });
      await db.open();

      const items = db.table<{ id?: number; buffer: ArrayBuffer }, number>("items");
      const buffer = new ArrayBuffer(8);
      const view = new Uint8Array(buffer);
      view.set([1, 2, 3, 4, 5, 6, 7, 8]);

      const id = await items.add({ buffer });
      const result = await items.get(id);

      expect(result?.buffer).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(result!.buffer)).toEqual(view);
    });

    it("stores and retrieves Uint8Array", async () => {
      db.version(1).stores({ items: "++id" });
      await db.open();

      const items = db.table<{ id?: number; data: Uint8Array }, number>("items");
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      const id = await items.add({ data });
      const result = await items.get(id);

      expect(result?.data).toBeInstanceOf(Uint8Array);
      expect(result?.data).toEqual(data);
    });
  });

  describe("partial update edge cases", () => {
    it("update preserves unmentioned fields", async () => {
      db.version(1).stores({ users: "++id, name" });
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      await users.update(id, { age: 31 });

      const result = await users.get(id);
      expect(result?.name).toBe("Alice");
      expect(result?.email).toBe("a@test.com");
      expect(result?.age).toBe(31);
    });

    it("update can set field to undefined", async () => {
      db.version(1).stores({ users: "++id, name" });
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      await users.update(id, { age: undefined });

      const result = await users.get(id);
      expect(result?.age).toBeUndefined();
    });

    it("update can set field to null", async () => {
      db.version(1).stores({ items: "++id" });
      await db.open();

      const items = db.table<{ id?: number; value: string | null }, number>("items");
      const id = await items.add({ value: "test" });

      await items.update(id, { value: null });

      const result = await items.get(id);
      expect(result?.value).toBeNull();
    });
  });
});

// ============================================================================
// Query Edge Cases
// ============================================================================

describe("query edge cases", () => {
  let db: LessDB;

  beforeEach(async () => {
    db = new LessDB(generateDbName("query-edge"));
    db.version(1).stores({
      users: "++id, name, age",
      settings: "key",
    });
    await db.open();
  });

  afterEach(async () => {
    await cleanupDB(db);
  });

  describe("empty anyOf", () => {
    it("returns empty result for anyOf with empty array", async () => {
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      const results = await users.where("age").anyOf([]).toArray();

      expect(results).toEqual([]);
    });

    it("returns empty count for anyOf with empty array", async () => {
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      const count = await users.where("age").anyOf([]).count();

      expect(count).toBe(0);
    });
  });

  describe("boundary conditions", () => {
    beforeEach(async () => {
      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 20 },
        { name: "Bob", email: "b@test.com", age: 25 },
        { name: "Charlie", email: "c@test.com", age: 30 },
        { name: "Diana", email: "d@test.com", age: 35 },
      ]);
    });

    it("above with exact match excludes boundary", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").above(25).toArray();

      expect(results.map((u) => u.name)).toEqual(["Charlie", "Diana"]);
    });

    it("aboveOrEqual with exact match includes boundary", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").aboveOrEqual(25).toArray();

      expect(results.map((u) => u.name)).toEqual(["Bob", "Charlie", "Diana"]);
    });

    it("below with exact match excludes boundary", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").below(25).toArray();

      expect(results.map((u) => u.name)).toEqual(["Alice"]);
    });

    it("belowOrEqual with exact match includes boundary", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").belowOrEqual(25).toArray();

      expect(results.map((u) => u.name)).toEqual(["Alice", "Bob"]);
    });

    it("between default excludes upper boundary", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").between(20, 30).toArray();

      // Default: includeLower=true, includeUpper=false
      expect(results.map((u) => u.name)).toEqual(["Alice", "Bob"]);
    });

    it("between can include both boundaries", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").between(20, 30, true, true).toArray();

      expect(results.map((u) => u.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });

    it("between can exclude both boundaries", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").between(20, 35, false, false).toArray();

      expect(results.map((u) => u.name)).toEqual(["Bob", "Charlie"]);
    });
  });

  describe("limit and offset edge cases", () => {
    beforeEach(async () => {
      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "User1", email: "u1@test.com", age: 1 },
        { name: "User2", email: "u2@test.com", age: 2 },
        { name: "User3", email: "u3@test.com", age: 3 },
        { name: "User4", email: "u4@test.com", age: 4 },
        { name: "User5", email: "u5@test.com", age: 5 },
      ]);
    });

    it("limit(0) returns empty array", async () => {
      const users = db.table<User, number>("users");
      const results = await users.toCollection().limit(0).toArray();

      expect(results).toEqual([]);
    });

    it("offset beyond data returns empty array", async () => {
      const users = db.table<User, number>("users");
      const results = await users.toCollection().offset(100).toArray();

      expect(results).toEqual([]);
    });

    it("limit larger than data returns all", async () => {
      const users = db.table<User, number>("users");
      const results = await users.toCollection().limit(100).toArray();

      expect(results).toHaveLength(5);
    });

    it("offset equals data length returns empty", async () => {
      const users = db.table<User, number>("users");
      const results = await users.toCollection().offset(5).toArray();

      expect(results).toEqual([]);
    });
  });

  describe("empty table queries", () => {
    it("toArray on empty table returns empty array", async () => {
      const users = db.table<User, number>("users");
      const results = await users.toArray();

      expect(results).toEqual([]);
    });

    it("count on empty table returns 0", async () => {
      const users = db.table<User, number>("users");
      const count = await users.count();

      expect(count).toBe(0);
    });

    it("first on empty table returns undefined", async () => {
      const users = db.table<User, number>("users");
      const result = await users.toCollection().first();

      expect(result).toBeUndefined();
    });

    it("last on empty table returns undefined", async () => {
      const users = db.table<User, number>("users");
      const result = await users.toCollection().last();

      expect(result).toBeUndefined();
    });
  });
});

// ============================================================================
// Error Propagation
// ============================================================================

describe("error propagation", () => {
  let db: LessDB;

  beforeEach(() => {
    db = new LessDB(generateDbName("error-edge"));
  });

  afterEach(async () => {
    await cleanupDB(db);
  });

  describe("upgrade function errors", () => {
    it("failed upgrade preserves previous version data", async () => {
      // Create v1 database with data
      const db1 = new LessDB(db.name);
      db1.version(1).stores({ users: "++id, name" });
      await db1.open();
      await db1.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
      db1.close();

      // Try to upgrade to v2 with failing upgrade function
      const db2 = new LessDB(db.name);
      db2.version(1).stores({ users: "++id, name" });
      db2
        .version(2)
        .stores({ users: "++id, name, email" })
        .upgrade(async () => {
          throw new Error("Upgrade failed!");
        });

      await expect(db2.open()).rejects.toThrow("Upgrade failed!");

      // Verify data is preserved (database should still be at v1 or intact)
      const db3 = new LessDB(db.name);
      db3.version(1).stores({ users: "++id, name" });
      await db3.open();

      const users = await db3.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe("Alice");

      db3.close();
    });
  });

  describe("constraint error handling", () => {
    it("constraint error is ConstraintError type", async () => {
      db.version(1).stores({ users: "++id, &email" });
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "shared@test.com" });

      try {
        await users.add({ name: "Bob", email: "shared@test.com" });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ConstraintError);
      }
    });

    it("caught constraint error allows continuing", async () => {
      db.version(1).stores({ users: "++id, &email" });
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com" });

      // This will fail
      try {
        await users.add({ name: "Bob", email: "a@test.com" });
      } catch {
        // Ignore
      }

      // Should still be able to add a different user
      const id = await users.add({ name: "Charlie", email: "c@test.com" });
      expect(id).toBeDefined();
    });
  });

  describe("transaction error handling", () => {
    it("error in transaction callback aborts transaction", async () => {
      db.version(1).stores({ users: "++id, name" });
      await db.open();

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          await tx.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
          throw new Error("Intentional error");
        }),
      ).rejects.toThrow("Intentional error");

      // Verify write was rolled back
      const count = await db.table<User, number>("users").count();
      expect(count).toBe(0);
    });

    it("constraint error in transaction aborts entire transaction", async () => {
      db.version(1).stores({ users: "++id, &email" });
      await db.open();

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          const users = tx.table<User, number>("users");
          await users.add({ name: "Alice", email: "shared@test.com" });
          await users.add({ name: "Bob", email: "shared@test.com" }); // Will fail
        }),
      ).rejects.toThrow(ConstraintError);

      // Both writes should be rolled back
      const count = await db.table<User, number>("users").count();
      expect(count).toBe(0);
    });
  });
});

// ============================================================================
// Stress/Performance Tests
// ============================================================================

describe("stress and performance", () => {
  let db: LessDB;

  beforeEach(() => {
    db = new LessDB(generateDbName("stress"));
    db.version(1).stores({
      items: "++id, value",
    });
  });

  afterEach(async () => {
    await cleanupDB(db);
  });

  describe("high-volume operations", () => {
    it("handles 1000 sequential adds in transaction", async () => {
      await db.open();

      await db.transaction("rw", ["items"], async (tx) => {
        const items = tx.table<{ id?: number; value: number }, number>("items");
        for (let i = 0; i < 1000; i++) {
          await items.add({ value: i });
        }
      });

      const count = await db.table("items").count();
      expect(count).toBe(1000);
    });

    it("handles 1000 items in bulkAdd", async () => {
      await db.open();

      const data = Array.from({ length: 1000 }, (_, i) => ({ value: i }));
      await db.table<{ id?: number; value: number }, number>("items").bulkAdd(data);

      const count = await db.table("items").count();
      expect(count).toBe(1000);
    });

    it("handles 1000 modifications in single transaction", async () => {
      await db.open();

      const items = db.table<{ id?: number; value: number }, number>("items");
      const id = await items.add({ value: 0 });

      await db.transaction("rw", ["items"], async (tx) => {
        const txItems = tx.table<{ id?: number; value: number }, number>("items");
        for (let i = 0; i < 1000; i++) {
          await txItems.update(id, { value: i + 1 });
        }
      });

      const item = await items.get(id);
      expect(item?.value).toBe(1000);
    });

    it("handles large collection deletion", async () => {
      await db.open();

      // Add 1000 items
      const data = Array.from({ length: 1000 }, (_, i) => ({ value: i }));
      await db.table<{ id?: number; value: number }, number>("items").bulkAdd(data);

      // Delete all via collection
      const deleted = await db
        .table<{ id?: number; value: number }, number>("items")
        .toCollection()
        .delete();

      expect(deleted).toBe(1000);

      const count = await db.table("items").count();
      expect(count).toBe(0);
    });

    it("handles many modify operations", async () => {
      await db.open();

      // Add 100 items
      const data = Array.from({ length: 100 }, (_, i) => ({ value: i }));
      await db.table<{ id?: number; value: number }, number>("items").bulkAdd(data);

      // Modify all items
      const modified = await db
        .table<{ id?: number; value: number }, number>("items")
        .toCollection()
        .modify((item) => {
          item.value = item.value * 2;
        });

      expect(modified).toBe(100);

      // Verify modifications
      const items = await db.table<{ id?: number; value: number }, number>("items").toArray();
      expect(items[0].value).toBe(0);
      expect(items[50].value).toBe(100);
      expect(items[99].value).toBe(198);
    });
  });

  describe("concurrent operations", () => {
    it("handles parallel reads", async () => {
      await db.open();

      const items = db.table<{ id?: number; value: number }, number>("items");
      await items.bulkAdd(Array.from({ length: 100 }, (_, i) => ({ value: i })));

      // Run 10 parallel read operations
      const results = await Promise.all([
        items.count(),
        items.toArray(),
        items.where("value").above(50).count(),
        items.where("value").below(50).count(),
        items.toCollection().first(),
        items.toCollection().last(),
        items.where("value").equals(25).first(),
        items.where("value").between(40, 60).count(),
        items.toCollection().limit(10).toArray(),
        items.where("value").anyOf([1, 2, 3, 4, 5]).toArray(),
      ]);

      // Verify all 10 results
      expect(results[0]).toBe(100); // count
      expect((results[1] as unknown[]).length).toBe(100); // toArray
      expect(results[2]).toBe(49); // above 50 (51-99)
      expect(results[3]).toBe(50); // below 50 (0-49)
      expect((results[4] as { value: number }).value).toBe(0); // first
      expect((results[5] as { value: number }).value).toBe(99); // last
      expect((results[6] as { value: number }).value).toBe(25); // equals 25
      expect(results[7]).toBe(20); // between 40-60 (40-59 inclusive lower, exclusive upper = 20 items)
      expect((results[8] as unknown[]).length).toBe(10); // limit 10
      expect((results[9] as unknown[]).length).toBe(5); // anyOf [1,2,3,4,5]
    });
  });
});

// ============================================================================
// Hook Integration
// ============================================================================

describe("hook integration scenarios", () => {
  let db: LessDB;

  beforeEach(() => {
    db = new LessDB(generateDbName("hook-integration"));
    db.version(1).stores({
      users: "++id, name",
      audit: "++id, action, timestamp",
    });
  });

  afterEach(async () => {
    await cleanupDB(db);
  });

  describe("custom type transformation", () => {
    it("transforms custom date type on create and read", async () => {
      await db.open();

      interface CustomDate {
        _year: number;
        _month: number;
        _day: number;
      }

      interface UserWithDate {
        id?: number;
        name: string;
        birthDate: Date | CustomDate;
      }

      const users = db.table<UserWithDate, number>("users");

      // Transform CustomDate to Date on create
      users.hook.creating.subscribe((key, obj) => {
        const date = obj.birthDate;
        if (date && "_year" in date) {
          obj.birthDate = new Date(date._year, date._month, date._day);
        }
      });

      // Transform Date back to CustomDate on read
      users.hook.reading.subscribe((obj) => {
        if (obj.birthDate instanceof Date) {
          obj.birthDate = {
            _year: obj.birthDate.getFullYear(),
            _month: obj.birthDate.getMonth(),
            _day: obj.birthDate.getDate(),
          };
        }
        return obj;
      });

      // Add with CustomDate
      const customDate: CustomDate = { _year: 2024, _month: 5, _day: 15 };
      const id = await users.add({ name: "Alice", birthDate: customDate });

      // Read should get CustomDate back
      const user = await users.get(id);
      expect(user?.birthDate).toEqual({ _year: 2024, _month: 5, _day: 15 });
    });
  });

  describe("hook error handling in transactions", () => {
    it("hook error rolls back transaction", async () => {
      await db.open();

      const users = db.table<User, number>("users");
      users.hook.creating.subscribe(() => {
        throw new Error("Hook validation failed");
      });

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          await tx.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
        }),
      ).rejects.toThrow("Hook validation failed");

      // Transaction should have been rolled back
      // Note: The throwing hook is still active, but we can count via a new db instance
      // or directly query since count() doesn't trigger creating hook
      const count = await db.table<User, number>("users").count();
      expect(count).toBe(0);
    });
  });
});

// ============================================================================
// Database Lifecycle Edge Cases
// ============================================================================

describe("database lifecycle edge cases", () => {
  describe("multiple database instances", () => {
    it("changes in one instance are visible in another after reopen", async () => {
      const dbName = generateDbName("multi-instance");

      // First instance
      const db1 = new LessDB(dbName);
      db1.version(1).stores({ users: "++id, name" });
      await db1.open();
      await db1.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });
      db1.close();

      // Second instance
      const db2 = new LessDB(dbName);
      db2.version(1).stores({ users: "++id, name" });
      await db2.open();

      const users = await db2.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe("Alice");

      await cleanupDB(db2);
    });
  });

  describe("close and reopen", () => {
    it("can close and reopen database", async () => {
      const dbName = generateDbName("close-reopen");

      const db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      await db.open();
      await db.table<User, number>("users").add({ name: "Alice", email: "a@test.com" });

      db.close();
      expect(db.isOpen).toBe(false);

      await db.open();
      expect(db.isOpen).toBe(true);

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);

      await cleanupDB(db);
    });
  });
});

// ============================================================================
// Type-Based Error Catching (LessDBPromise)
// ============================================================================

describe("type-based error catching", () => {
  let db: LessDB;

  beforeEach(async () => {
    db = new LessDB(generateDbName("promise-test"));
    db.version(1).stores({
      users: "++id, name, &email",
    });
    await db.open();
  });

  afterEach(async () => {
    await cleanupDB(db);
  });

  it("Table methods return LessDBPromise", () => {
    const users = db.table<User, number>("users");

    expect(users.get(1)).toBeInstanceOf(LessDBPromise);
    expect(users.add({ name: "Test", email: "test@test.com" })).toBeInstanceOf(LessDBPromise);
    expect(users.put({ name: "Test", email: "test2@test.com" })).toBeInstanceOf(LessDBPromise);
    expect(users.bulkGet([1, 2])).toBeInstanceOf(LessDBPromise);
    expect(users.count()).toBeInstanceOf(LessDBPromise);
    expect(users.toArray()).toBeInstanceOf(LessDBPromise);
  });

  it("chains then() on successful operations", async () => {
    const users = db.table<User, number>("users");

    const id = await users
      .add({ name: "Alice", email: "alice@test.com" })
      .then((id) => id * 10);

    expect(id).toBeGreaterThan(0);
  });

  it("catch() with no type catches any error", async () => {
    const users = db.table<User, number>("users");
    await users.add({ name: "Alice", email: "alice@test.com" });

    // Standard catch should work
    const result = await users
      .add({ name: "Dupe", email: "alice@test.com" })
      .catch(() => -1);

    expect(result).toBe(-1);
  });

  it("type-based catch matches error type (via standard promise)", async () => {
    const users = db.table<User, number>("users");
    await users.add({ name: "Alice", email: "alice@test.com" });

    // Use standard await + catch to verify the error type
    let wasConstraintError = false;
    try {
      await users.add({ name: "Dupe", email: "alice@test.com" });
    } catch (err) {
      wasConstraintError = err instanceof ConstraintError;
    }

    expect(wasConstraintError).toBe(true);
  });

  it("finally() executes on success", async () => {
    const users = db.table<User, number>("users");
    const cleanup = vi.fn();

    await users.add({ name: "Alice", email: "alice@test.com" }).finally(cleanup);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("finally() executes on error", async () => {
    const users = db.table<User, number>("users");
    await users.add({ name: "Alice", email: "alice@test.com" });

    const cleanup = vi.fn();

    await users
      .add({ name: "Dupe", email: "alice@test.com" })
      .catch(() => -1)
      .finally(cleanup);

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
