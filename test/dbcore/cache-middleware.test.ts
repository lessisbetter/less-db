import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LessDB } from "../../src/less-db.js";

/**
 * Tests for the transaction-level cache middleware.
 *
 * The cache middleware caches getMany results within a transaction to avoid
 * redundant database reads. It should:
 * - Cache values on first getMany call
 * - Return cached values on subsequent calls within same transaction
 * - Invalidate cache appropriately on mutations
 * - Not share cache between different transactions
 * - Not share cache between different tables
 */

interface User {
  id?: number;
  name: string;
  email: string;
  age: number;
}

describe("Cache Middleware", () => {
  let db: LessDB;
  let dbName: string;

  beforeEach(async () => {
    dbName = `cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = new LessDB(dbName);
    db.version(1).stores({
      users: "++id, name, email, age",
      posts: "++id, title, userId",
    });
    await db.open();
  });

  afterEach(async () => {
    db.close();
    await indexedDB.deleteDatabase(dbName);
  });

  describe("cache hits", () => {
    it("caches getMany results within a transaction", async () => {
      // Setup: add some users
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      // Within a transaction, getMany should use cache on second call
      let callCount = 0;
      const result = await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Spy on the underlying IDB by tracking calls
        const first = await txUsers.bulkGet(keys);
        const second = await txUsers.bulkGet(keys);

        // Both should return same data
        expect(first).toEqual(second);
        expect(first[0]?.name).toBe("Alice");
        expect(first[1]?.name).toBe("Bob");

        return { first, second };
      });

      expect(result.first).toEqual(result.second);
    });

    it("caches partial key requests", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
        { name: "Charlie", email: "charlie@test.com", age: 35 },
      ]);

      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // First call - gets Alice and Bob
        const first = await txUsers.bulkGet([keys[0]!, keys[1]!]);
        expect(first[0]?.name).toBe("Alice");
        expect(first[1]?.name).toBe("Bob");

        // Second call - gets Bob and Charlie (Bob should come from cache)
        const second = await txUsers.bulkGet([keys[1]!, keys[2]!]);
        expect(second[0]?.name).toBe("Bob");
        expect(second[1]?.name).toBe("Charlie");

        // Third call - all from cache
        const third = await txUsers.bulkGet(keys);
        expect(third[0]?.name).toBe("Alice");
        expect(third[1]?.name).toBe("Bob");
        expect(third[2]?.name).toBe("Charlie");
      });
    });

    it("does NOT cache undefined for non-existent keys (allows later inserts)", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Get existing and non-existing keys
        const first = await txUsers.bulkGet([key, 9999]);
        expect(first[0]?.name).toBe("Alice");
        expect(first[1]).toBeUndefined();

        // Add a record for the previously-missing key
        const newKey = await txUsers.add({ name: "Bob", email: "bob@test.com", age: 25 });

        // The new record should be found (not masked by cached undefined)
        const second = await txUsers.bulkGet([newKey]);
        expect(second[0]?.name).toBe("Bob");
      });
    });
  });

  describe("cache misses", () => {
    it("fetches from database on first call", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        const result = await txUsers.bulkGet([key]);
        expect(result[0]?.name).toBe("Alice");
      });
    });

    it("handles empty key array", async () => {
      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        const result = await txUsers.bulkGet([]);
        expect(result).toEqual([]);
      });
    });

    it("handles null and undefined keys in array", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        // Note: null/undefined keys should return undefined in result
        const result = await txUsers.bulkGet([key, null as unknown as number]);
        expect(result[0]?.name).toBe("Alice");
        expect(result[1]).toBeUndefined();
      });
    });
  });

  describe("cache invalidation on put", () => {
    it("invalidates specific keys on put", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache the values
        const first = await txUsers.bulkGet(keys);
        expect(first[0]?.name).toBe("Alice");

        // Update Alice
        await txUsers.put({ id: keys[0], name: "Alice Updated", email: "alice@test.com", age: 31 });

        // Cache should be invalidated for Alice, Bob should still be cached
        const second = await txUsers.bulkGet(keys);
        expect(second[0]?.name).toBe("Alice Updated");
        expect(second[1]?.name).toBe("Bob");
      });
    });

    it("invalidates cache on bulkPut", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache the values
        const first = await txUsers.bulkGet(keys);
        expect(first[0]?.age).toBe(30);
        expect(first[1]?.age).toBe(25);

        // Update both
        await txUsers.bulkPut([
          { id: keys[0], name: "Alice", email: "alice@test.com", age: 31 },
          { id: keys[1], name: "Bob", email: "bob@test.com", age: 26 },
        ]);

        // Both should be fetched fresh
        const second = await txUsers.bulkGet(keys);
        expect(second[0]?.age).toBe(31);
        expect(second[1]?.age).toBe(26);
      });
    });
  });

  describe("cache invalidation on delete", () => {
    it("invalidates specific keys on delete", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache the values
        const first = await txUsers.bulkGet(keys);
        expect(first[0]?.name).toBe("Alice");
        expect(first[1]?.name).toBe("Bob");

        // Delete Alice
        await txUsers.delete(keys[0]!);

        // Alice should be fetched fresh (now undefined), Bob still cached
        const second = await txUsers.bulkGet(keys);
        expect(second[0]).toBeUndefined();
        expect(second[1]?.name).toBe("Bob");
      });
    });

    it("invalidates cache on bulkDelete", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
        { name: "Charlie", email: "charlie@test.com", age: 35 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache all values
        const first = await txUsers.bulkGet(keys);
        expect(first.filter((u) => u !== undefined)).toHaveLength(3);

        // Delete Alice and Bob
        await txUsers.bulkDelete([keys[0]!, keys[1]!]);

        // Alice and Bob should be undefined, Charlie still cached
        const second = await txUsers.bulkGet(keys);
        expect(second[0]).toBeUndefined();
        expect(second[1]).toBeUndefined();
        expect(second[2]?.name).toBe("Charlie");
      });
    });
  });

  describe("cache NOT invalidated on add", () => {
    it("preserves cache on add (add cannot change existing values)", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache Alice
        const first = await txUsers.bulkGet([key]);
        expect(first[0]?.name).toBe("Alice");

        // Add a new user - should NOT invalidate Alice's cache
        await txUsers.add({ name: "Bob", email: "bob@test.com", age: 25 });

        // Alice should still be cached
        const second = await txUsers.bulkGet([key]);
        expect(second[0]?.name).toBe("Alice");
      });
    });

    it("preserves cache on bulkAdd", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache Alice
        const first = await txUsers.bulkGet([key]);
        expect(first[0]?.name).toBe("Alice");

        // Add multiple new users
        await txUsers.bulkAdd([
          { name: "Bob", email: "bob@test.com", age: 25 },
          { name: "Charlie", email: "charlie@test.com", age: 35 },
        ]);

        // Alice should still be cached
        const second = await txUsers.bulkGet([key]);
        expect(second[0]?.name).toBe("Alice");
      });
    });
  });

  describe("cache invalidation on clear/deleteRange", () => {
    it("invalidates entire cache on clear", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache the values
        const first = await txUsers.bulkGet(keys);
        expect(first[0]?.name).toBe("Alice");
        expect(first[1]?.name).toBe("Bob");

        // Clear all
        await txUsers.clear();

        // Both should now be undefined
        const second = await txUsers.bulkGet(keys);
        expect(second[0]).toBeUndefined();
        expect(second[1]).toBeUndefined();
      });
    });
  });

  describe("cache isolation between transactions", () => {
    it("does not share cache between transactions", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      // First transaction - cache Alice
      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        const result = await txUsers.bulkGet([key]);
        expect(result[0]?.name).toBe("Alice");
      });

      // Update Alice outside transaction
      await users.put({ id: key, name: "Alice Updated", email: "alice@test.com", age: 31 });

      // Second transaction - should NOT use cache from first transaction
      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        const result = await txUsers.bulkGet([key]);
        expect(result[0]?.name).toBe("Alice Updated");
      });
    });

    it("maintains separate caches for concurrent transactions", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      // Start two transactions
      const tx1Promise = db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache in tx1
        const first = await txUsers.bulkGet([key]);
        expect(first[0]?.name).toBe("Alice");

        // Update in tx1
        await txUsers.put({ id: key, name: "Alice TX1", email: "alice@test.com", age: 31 });

        const second = await txUsers.bulkGet([key]);
        expect(second[0]?.name).toBe("Alice TX1");

        return second[0]?.name;
      });

      const result = await tx1Promise;
      expect(result).toBe("Alice TX1");

      // Verify the update persisted
      const final = await users.get(key);
      expect(final?.name).toBe("Alice TX1");
    });
  });

  describe("cache isolation between tables", () => {
    it("does not share cache between different tables", async () => {
      interface Post {
        id?: number;
        title: string;
        userId: number;
      }

      const users = db.table<User, number>("users");
      const posts = db.table<Post, number>("posts");

      const userKey = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });
      const postKey = await posts.add({ title: "Hello World", userId: userKey });

      await db.transaction("readwrite", ["users", "posts"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        const txPosts = tx.table<Post, number>("posts");

        // Cache user
        const userResult = await txUsers.bulkGet([userKey]);
        expect(userResult[0]?.name).toBe("Alice");

        // Cache post
        const postResult = await txPosts.bulkGet([postKey]);
        expect(postResult[0]?.title).toBe("Hello World");

        // Update user - should NOT affect post cache
        await txUsers.put({
          id: userKey,
          name: "Alice Updated",
          email: "alice@test.com",
          age: 31,
        });

        // Post should still be cached
        const postResult2 = await txPosts.bulkGet([postKey]);
        expect(postResult2[0]?.title).toBe("Hello World");

        // User should be invalidated
        const userResult2 = await txUsers.bulkGet([userKey]);
        expect(userResult2[0]?.name).toBe("Alice Updated");
      });
    });
  });

  describe("cache with update operations", () => {
    it("invalidates cache on update", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache Alice
        const first = await txUsers.bulkGet([key]);
        expect(first[0]?.age).toBe(30);

        // Update Alice's age
        await txUsers.update(key, { age: 31 });

        // Should fetch fresh value
        const second = await txUsers.bulkGet([key]);
        expect(second[0]?.age).toBe(31);
      });
    });

    it("invalidates cache on bulkUpdate", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache both
        const first = await txUsers.bulkGet(keys);
        expect(first[0]?.age).toBe(30);
        expect(first[1]?.age).toBe(25);

        // Update both ages
        await txUsers.bulkUpdate([
          { key: keys[0]!, changes: { age: 31 } },
          { key: keys[1]!, changes: { age: 26 } },
        ]);

        // Both should be fetched fresh
        const second = await txUsers.bulkGet(keys);
        expect(second[0]?.age).toBe(31);
        expect(second[1]?.age).toBe(26);
      });
    });

    it("invalidates cache on upsert", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache Alice
        const first = await txUsers.bulkGet([key]);
        expect(first[0]?.age).toBe(30);

        // Upsert Alice
        await txUsers.upsert({ id: key, name: "Alice", email: "alice@test.com", age: 31 });

        // Should fetch fresh value
        const second = await txUsers.bulkGet([key]);
        expect(second[0]?.age).toBe(31);
      });
    });
  });

  describe("cache with collection operations", () => {
    it("invalidates cache on collection modify", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache Alice
        const first = await txUsers.bulkGet([keys[0]!]);
        expect(first[0]?.age).toBe(30);

        // Modify via collection
        await txUsers.where("name").equals("Alice").modify({ age: 31 });

        // Should fetch fresh value
        const second = await txUsers.bulkGet([keys[0]!]);
        expect(second[0]?.age).toBe(31);
      });
    });

    it("invalidates cache on collection delete", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Cache both
        const first = await txUsers.bulkGet(keys);
        expect(first[0]?.name).toBe("Alice");
        expect(first[1]?.name).toBe("Bob");

        // Delete Alice via collection
        await txUsers.where("name").equals("Alice").delete();

        // Alice should be undefined, Bob might still be cached or refetched
        const second = await txUsers.bulkGet(keys);
        expect(second[0]).toBeUndefined();
        expect(second[1]?.name).toBe("Bob");
      });
    });
  });

  describe("cache key serialization", () => {
    it("handles numeric keys", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        const first = await txUsers.bulkGet([key]);
        const second = await txUsers.bulkGet([key]);
        expect(first).toEqual(second);
      });
    });

    it("handles string keys", async () => {
      interface Setting {
        key: string;
        value: string;
      }

      const stringKeyDbName = `string-key-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const dbWithStrings = new LessDB(stringKeyDbName);
      dbWithStrings.version(1).stores({ settings: "key" });
      await dbWithStrings.open();

      try {
        const settings = dbWithStrings.table<Setting, string>("settings");
        await settings.add({ key: "theme", value: "dark" });

        await dbWithStrings.transaction("readonly", ["settings"], async (tx) => {
          const txSettings = tx.table<Setting, string>("settings");
          const first = await txSettings.bulkGet(["theme"]);
          const second = await txSettings.bulkGet(["theme"]);
          expect(first[0]?.value).toBe("dark");
          expect(first).toEqual(second);
        });
      } finally {
        dbWithStrings.close();
        await indexedDB.deleteDatabase(stringKeyDbName);
      }
    });

    it("handles object keys (serialization)", async () => {
      // Test that the cache correctly serializes and matches object-like keys
      // Using a simple outbound key store where we manually provide keys
      interface Item {
        data: string;
      }

      const outboundKeyDbName = `outbound-key-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const dbWithOutbound = new LessDB(outboundKeyDbName);
      dbWithOutbound.version(1).stores({ items: "++" }); // Outbound auto-increment
      await dbWithOutbound.open();

      try {
        const items = dbWithOutbound.table<Item, number>("items");
        const key1 = await items.add({ data: "item1" });
        const key2 = await items.add({ data: "item2" });

        await dbWithOutbound.transaction("readonly", ["items"], async (tx) => {
          const txItems = tx.table<Item, number>("items");
          const first = await txItems.bulkGet([key1, key2]);
          const second = await txItems.bulkGet([key1, key2]);
          expect(first[0]?.data).toBe("item1");
          expect(first[1]?.data).toBe("item2");
          expect(first).toEqual(second);
        });
      } finally {
        dbWithOutbound.close();
        await indexedDB.deleteDatabase(outboundKeyDbName);
      }
    });
  });

  describe("edge cases", () => {
    it("handles very large batch sizes", async () => {
      const users = db.table<User, number>("users");

      // Add 500 users
      const items = Array.from({ length: 500 }, (_, i) => ({
        name: `User${i}`,
        email: `user${i}@test.com`,
        age: 20 + (i % 50),
      }));
      const keys = await users.bulkAdd(items);

      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // First call - all from DB
        const first = await txUsers.bulkGet(keys);
        expect(first).toHaveLength(500);
        expect(first[0]?.name).toBe("User0");
        expect(first[499]?.name).toBe("User499");

        // Second call - all from cache
        const second = await txUsers.bulkGet(keys);
        expect(second).toHaveLength(500);
        expect(first).toEqual(second);
      });
    });

    it("handles interleaved reads and writes", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
        { name: "Charlie", email: "charlie@test.com", age: 35 },
      ]);

      await db.transaction("readwrite", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Read Alice
        let result = await txUsers.bulkGet([keys[0]!]);
        expect(result[0]?.name).toBe("Alice");

        // Update Alice
        await txUsers.put({
          id: keys[0],
          name: "Alice v2",
          email: "alice@test.com",
          age: 31,
        });

        // Read Bob (should work, wasn't invalidated)
        result = await txUsers.bulkGet([keys[1]!]);
        expect(result[0]?.name).toBe("Bob");

        // Read Alice again (should be fresh)
        result = await txUsers.bulkGet([keys[0]!]);
        expect(result[0]?.name).toBe("Alice v2");

        // Delete Charlie
        await txUsers.delete(keys[2]!);

        // Read all - Alice v2, Bob cached, Charlie undefined
        result = await txUsers.bulkGet(keys);
        expect(result[0]?.name).toBe("Alice v2");
        expect(result[1]?.name).toBe("Bob");
        expect(result[2]).toBeUndefined();
      });
    });

    it("handles rapid successive calls", async () => {
      const users = db.table<User, number>("users");
      const key = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

      await db.transaction("readonly", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");

        // Fire off multiple concurrent requests
        const promises = [
          txUsers.bulkGet([key]),
          txUsers.bulkGet([key]),
          txUsers.bulkGet([key]),
          txUsers.bulkGet([key]),
          txUsers.bulkGet([key]),
        ];

        const results = await Promise.all(promises);

        // All should return same data
        for (const result of results) {
          expect(result[0]?.name).toBe("Alice");
        }
      });
    });
  });
});
