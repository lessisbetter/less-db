/**
 * Tests for IndexedDB 3.0 features.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LessDB,
  supportsDurability,
  supportsCommit,
  type TransactionOptions,
} from "../src/index.js";

interface User {
  id?: number;
  name: string;
  email: string;
}

describe("IndexedDB 3.0 Features", () => {
  let db: LessDB;

  beforeEach(async () => {
    db = new LessDB(`test-idb3-${Date.now()}`);
    db.version(1).stores({
      users: "++id, name, email",
    });
    await db.open();
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  describe("feature detection", () => {
    it("supportsDurability returns a boolean", () => {
      expect(typeof supportsDurability()).toBe("boolean");
    });

    it("supportsCommit returns a boolean", () => {
      expect(typeof supportsCommit()).toBe("boolean");
    });
  });

  describe("transaction durability", () => {
    it("accepts durability: 'default' option", async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });
        },
        { durability: "default" },
      );

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Alice");
    });

    it("accepts durability: 'relaxed' option", async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").add({ name: "Bob", email: "bob@test.com" });
        },
        { durability: "relaxed" },
      );

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Bob");
    });

    it("accepts durability: 'strict' option", async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").add({ name: "Charlie", email: "charlie@test.com" });
        },
        { durability: "strict" },
      );

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Charlie");
    });

    it("works without durability option (default behavior)", async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        await tx.table<User, number>("users").add({ name: "Dave", email: "dave@test.com" });
      });

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Dave");
    });
  });

  describe("transaction commit", () => {
    it("commit() method exists on transaction context", async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        expect(typeof tx.commit).toBe("function");
      });
    });

    it("commit() can be called without error", async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        await tx.table<User, number>("users").add({ name: "Eve", email: "eve@test.com" });
        // Explicitly commit
        tx.commit();
      });

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("Eve");
    });

    it("commit() after all operations complete still succeeds", async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        const table = tx.table<User, number>("users");
        await table.add({ name: "Frank", email: "frank@test.com" });
        await table.add({ name: "Grace", email: "grace@test.com" });
        tx.commit();
      });

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(2);
    });

    it("commit() is no-op after transaction completes", async () => {
      let savedTx: { commit: () => void; active: boolean } | undefined;
      await db.transaction("rw", ["users"], async (tx) => {
        savedTx = tx;
        await tx.table<User, number>("users").add({ name: "Test", email: "test@test.com" });
      });

      // Transaction has completed, commit() should be a no-op
      expect(savedTx).toBeDefined();
      expect(savedTx!.active).toBe(false);
      // Should not throw
      savedTx!.commit();
    });

    it("commit() after abort does not throw", async () => {
      let savedTx: { commit: () => void; active: boolean } | undefined;
      try {
        await db.transaction("rw", ["users"], async (tx) => {
          savedTx = tx;
          await tx.table<User, number>("users").add({ name: "Test", email: "test@test.com" });
          tx.abort();
        });
      } catch {
        // Expected - transaction was aborted
      }

      // Transaction has been aborted, commit() should be a no-op
      expect(savedTx).toBeDefined();
      expect(savedTx!.active).toBe(false);
      // Should not throw
      savedTx!.commit();
    });

    it("multiple commit() calls do not throw", async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        await tx.table<User, number>("users").add({ name: "Test", email: "test@test.com" });
        tx.commit();
        tx.commit(); // Second call should be no-op
        tx.commit(); // Third call should also be no-op
      });

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
    });

    it("commit() works with readonly transactions", async () => {
      // First add some data
      await db.table<User, number>("users").add({ name: "Test", email: "test@test.com" });

      // Then read in a readonly transaction with commit
      let result: User[] = [];
      await db.transaction("r", ["users"], async (tx) => {
        result = await tx.table<User, number>("users").toArray();
        tx.commit();
      });

      expect(result).toHaveLength(1);
    });
  });

  describe("TransactionOptions type", () => {
    it("allows partial options", async () => {
      const options: TransactionOptions = {};
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").add({ name: "Test", email: "test@test.com" });
        },
        options,
      );

      const users = await db.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);
    });
  });
});

describe("openKeyCursor optimization", () => {
  let db: LessDB;

  beforeEach(async () => {
    db = new LessDB(`test-keycursor-${Date.now()}`);
    db.version(1).stores({
      users: "++id, name, age",
    });
    await db.open();

    // Seed data
    const users = Array.from({ length: 20 }, (_, i) => ({
      name: `user${i}`,
      age: 20 + (i % 10),
    }));
    await db.table("users").bulkAdd(users);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it("primaryKeys() returns only keys without loading values", async () => {
    const keys = await db.table("users").where("age").equals(25).primaryKeys();

    expect(keys.length).toBeGreaterThan(0);
    expect(typeof keys[0]).toBe("number");
  });

  it("keys() returns primary keys (alias for primaryKeys)", async () => {
    // Get keys for users with age = 25 (there should be 2 users with age 25)
    const keys = await db.table("users").where("age").equals(25).keys();

    expect(keys.length).toBe(2);
    // keys() is an alias for primaryKeys(), so it returns auto-increment ids
    expect(keys.every((k) => typeof k === "number")).toBe(true);
  });

  it("eachPrimaryKey iterates over primary keys only", async () => {
    const keys: number[] = [];

    await db
      .table("users")
      .where("age")
      .equals(22)
      .eachPrimaryKey((key) => {
        keys.push(key as number);
      });

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => typeof k === "number")).toBe(true);
  });

  it("primaryKeys() works with above() query", async () => {
    const keys = await db.table("users").where("age").above(25).primaryKeys();

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => typeof k === "number")).toBe(true);
  });

  it("primaryKeys() works with below() query", async () => {
    const keys = await db.table("users").where("age").below(23).primaryKeys();

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => typeof k === "number")).toBe(true);
  });

  it("primaryKeys() works with between() query", async () => {
    const keys = await db.table("users").where("age").between(22, 26).primaryKeys();

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => typeof k === "number")).toBe(true);
  });

  it("primaryKeys() works with anyOf() query", async () => {
    const keys = await db.table("users").where("age").anyOf([22, 25, 28]).primaryKeys();

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => typeof k === "number")).toBe(true);
  });

  it("primaryKeys() works with orderBy()", async () => {
    const keys = await db.table("users").orderBy("age").primaryKeys();

    expect(keys.length).toBe(20);
    expect(keys.every((k) => typeof k === "number")).toBe(true);
  });

  it("primaryKeys() works with reverse()", async () => {
    const forwardKeys = await db.table("users").orderBy("id").primaryKeys();
    const reverseKeys = await db.table("users").orderBy("id").reverse().primaryKeys();

    expect(reverseKeys.length).toBe(forwardKeys.length);
    expect(reverseKeys).toEqual([...forwardKeys].reverse());
  });

  it("primaryKeys() works with limit()", async () => {
    const keys = await db.table("users").orderBy("id").limit(5).primaryKeys();

    expect(keys.length).toBe(5);
  });

  it("primaryKeys() works with offset()", async () => {
    const allKeys = await db.table("users").orderBy("id").primaryKeys();
    const offsetKeys = await db.table("users").orderBy("id").offset(5).primaryKeys();

    expect(offsetKeys.length).toBe(15);
    expect(offsetKeys).toEqual(allKeys.slice(5));
  });

  it("primaryKeys() returns empty array when no matches", async () => {
    const keys = await db.table("users").where("age").equals(999).primaryKeys();

    expect(keys).toEqual([]);
  });

  it("count() works efficiently on indexed queries", async () => {
    const count = await db.table("users").where("age").equals(25).count();

    expect(count).toBe(2);
  });

  it("count() with above() query", async () => {
    const count = await db.table("users").where("age").above(25).count();

    expect(count).toBeGreaterThan(0);
  });

  it("eachPrimaryKey iterates all matching keys", async () => {
    const keys: number[] = [];

    await db
      .table("users")
      .orderBy("id")
      .eachPrimaryKey((key) => {
        keys.push(key as number);
      });

    expect(keys.length).toBe(20);
    // Verify keys are in order
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]).toBeGreaterThan(keys[i - 1]!);
    }
  });
});

describe("cursor directions", () => {
  let db: LessDB;

  beforeEach(async () => {
    db = new LessDB(`test-cursor-directions-${Date.now()}`);
    db.version(1).stores({
      logs: "++id, category, level",
    });
    await db.open();

    // Seed data with duplicates
    const logs = [
      { category: "auth", level: "info" },
      { category: "auth", level: "info" },
      { category: "auth", level: "error" },
      { category: "system", level: "info" },
      { category: "system", level: "error" },
      { category: "system", level: "error" },
      { category: "api", level: "info" },
    ];
    await db.table("logs").bulkAdd(logs);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it("queries with duplicates return all matching records", async () => {
    // Get all logs with category 'auth' - should return 3 records
    const authLogs = await db.table("logs").where("category").equals("auth").toArray();
    expect(authLogs.length).toBe(3);
  });

  it("orderBy returns records ordered by index", async () => {
    // Order by category returns all records sorted
    const logs = await db.table("logs").orderBy("category").toArray();
    expect(logs.length).toBe(7);

    // Should be ordered: api, auth, auth, auth, system, system, system
    const categories = logs.map((l) => (l as { category: string }).category);
    expect(categories[0]).toBe("api");
    expect(categories[1]).toBe("auth");
    expect(categories[4]).toBe("system");
  });

  it("primaryKeys with unique index values work correctly", async () => {
    // Get primary keys for each category
    const authKeys = await db.table("logs").where("category").equals("auth").primaryKeys();
    const systemKeys = await db.table("logs").where("category").equals("system").primaryKeys();
    const apiKeys = await db.table("logs").where("category").equals("api").primaryKeys();

    expect(authKeys.length).toBe(3);
    expect(systemKeys.length).toBe(3);
    expect(apiKeys.length).toBe(1);
  });

  it("reverse() returns records in reverse order", async () => {
    const forward = await db.table("logs").orderBy("category").toArray();
    const reverse = await db.table("logs").orderBy("category").reverse().toArray();

    expect(reverse.length).toBe(forward.length);
    expect(reverse).toEqual([...forward].reverse());
  });

  it("first() returns first record in order", async () => {
    const first = await db.table("logs").orderBy("category").first();

    expect(first).toBeDefined();
    expect((first as { category: string }).category).toBe("api");
  });

  it("last() returns last record in order", async () => {
    const last = await db.table("logs").orderBy("category").last();

    expect(last).toBeDefined();
    expect((last as { category: string }).category).toBe("system");
  });

  it("reverse() with where clause", async () => {
    const forward = await db.table("logs").where("category").equals("auth").toArray();
    const reverse = await db.table("logs").where("category").equals("auth").reverse().toArray();

    expect(reverse.length).toBe(forward.length);
    expect(reverse).toEqual([...forward].reverse());
  });

  it("reverse() with limit()", async () => {
    const forward = await db.table("logs").orderBy("id").limit(3).toArray();
    const reverse = await db.table("logs").orderBy("id").reverse().limit(3).toArray();

    // Forward gets first 3, reverse gets last 3
    expect(forward.length).toBe(3);
    expect(reverse.length).toBe(3);

    // IDs should be different (first 3 vs last 3)
    const forwardIds = forward.map((l) => (l as { id: number }).id);
    const reverseIds = reverse.map((l) => (l as { id: number }).id);
    expect(forwardIds).not.toEqual(reverseIds);
  });

  it("reverse() with primaryKeys()", async () => {
    const forwardKeys = await db.table("logs").orderBy("id").primaryKeys();
    const reverseKeys = await db.table("logs").orderBy("id").reverse().primaryKeys();

    expect(reverseKeys).toEqual([...forwardKeys].reverse());
  });
});

describe("combined IDB3 features", () => {
  let db: LessDB;

  beforeEach(async () => {
    db = new LessDB(`test-combined-${Date.now()}`);
    db.version(1).stores({
      users: "++id, name, email",
    });
    await db.open();
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it("durability: relaxed with explicit commit()", async () => {
    await db.transaction(
      "rw",
      ["users"],
      async (tx) => {
        await tx.table<User, number>("users").add({ name: "Test", email: "test@test.com" });
        tx.commit();
      },
      { durability: "relaxed" },
    );

    const users = await db.table<User, number>("users").toArray();
    expect(users).toHaveLength(1);
  });

  it("durability: strict with bulkAdd", async () => {
    const usersToAdd = Array.from({ length: 10 }, (_, i) => ({
      name: `user${i}`,
      email: `user${i}@test.com`,
    }));

    await db.transaction(
      "rw",
      ["users"],
      async (tx) => {
        await tx.table<User, number>("users").bulkAdd(usersToAdd);
      },
      { durability: "strict" },
    );

    const users = await db.table<User, number>("users").toArray();
    expect(users).toHaveLength(10);
  });

  it("durability: relaxed with bulkAdd and commit()", async () => {
    const usersToAdd = Array.from({ length: 10 }, (_, i) => ({
      name: `user${i}`,
      email: `user${i}@test.com`,
    }));

    await db.transaction(
      "rw",
      ["users"],
      async (tx) => {
        await tx.table<User, number>("users").bulkAdd(usersToAdd);
        tx.commit();
      },
      { durability: "relaxed" },
    );

    const users = await db.table<User, number>("users").toArray();
    expect(users).toHaveLength(10);
  });

  it("multiple operations with explicit commit", async () => {
    await db.transaction("rw", ["users"], async (tx) => {
      const table = tx.table<User, number>("users");
      await table.add({ name: "Alice", email: "alice@test.com" });
      await table.add({ name: "Bob", email: "bob@test.com" });
      await table.put({ id: 1, name: "Alice Updated", email: "alice@test.com" });
      tx.commit();
    });

    const users = await db.table<User, number>("users").toArray();
    expect(users).toHaveLength(2);
    expect(users.find((u) => u.id === 1)?.name).toBe("Alice Updated");
  });
});
