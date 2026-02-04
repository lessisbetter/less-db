import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseTableSchema, type TableSchema } from "../../src/schema-parser.js";
import {
  createIDBCore,
  keyRangeEqual,
  keyRangeRange,
  keyRangeAnyOf,
  keyRangeAbove,
  keyRangeBelow,
  keyRangeAll,
  primaryKeyQuery,
  indexQuery,
  type DBCore,
  type InternalTransaction,
} from "../../src/dbcore/index.js";

describe("DBCore", () => {
  let db: IDBDatabase;
  let core: DBCore;
  let schemas: Map<string, TableSchema>;

  // Helper to open a fresh database
  async function openDatabase(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);

      request.onupgradeneeded = () => {
        const database = request.result;

        // Create users table: ++id, name, email (unique), age
        const usersStore = database.createObjectStore("users", {
          keyPath: "id",
          autoIncrement: true,
        });
        usersStore.createIndex("name", "name", { unique: false });
        usersStore.createIndex("email", "email", { unique: true });
        usersStore.createIndex("age", "age", { unique: false });

        // Create logs table: ++ (outbound auto-increment)
        database.createObjectStore("logs", { autoIncrement: true });

        // Create settings table: key (explicit primary key)
        database.createObjectStore("settings", { keyPath: "key" });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  beforeEach(async () => {
    // Create unique database name for test isolation
    const dbName = `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = await openDatabase(dbName);

    schemas = new Map([
      ["users", parseTableSchema("users", "++id, name, &email, age")],
      ["logs", parseTableSchema("logs", "++")],
      ["settings", parseTableSchema("settings", "key")],
    ]);

    core = createIDBCore(db, schemas);
  });

  afterEach(() => {
    db.close();
  });

  describe("table", () => {
    it("returns table by name", () => {
      const table = core.table("users");
      expect(table.name).toBe("users");
    });

    it("throws for unknown table", () => {
      expect(() => core.table("nonexistent")).toThrow('Table "nonexistent" not found');
    });
  });

  describe("transaction", () => {
    it("creates readonly transaction", () => {
      const trans = core.transaction(["users"], "readonly") as InternalTransaction;
      expect(trans.mode).toBe("readonly");
      expect(trans.tables).toEqual(["users"]);
    });

    it("creates readwrite transaction", () => {
      const trans = core.transaction(["users"], "readwrite") as InternalTransaction;
      expect(trans.mode).toBe("readwrite");
    });

    it("creates multi-table transaction", () => {
      const trans = core.transaction(["users", "logs"], "readwrite") as InternalTransaction;
      expect(trans.tables).toEqual(["users", "logs"]);
    });

    it("can abort transaction", async () => {
      const trans = core.transaction(["users"], "readwrite");
      const table = core.table("users");

      await table.mutate({
        trans,
        type: "add",
        values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
      });

      trans.abort();

      // After abort, the add should not have persisted
      const readTrans = core.transaction(["users"], "readonly");
      const result = await table.query({
        trans: readTrans,
        query: primaryKeyQuery(table.schema, keyRangeAll()),
      });

      expect(result.result).toHaveLength(0);
    });
  });

  describe("DBCoreTable", () => {
    describe("mutate - add", () => {
      it("adds single item", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        const result = await table.mutate({
          trans,
          type: "add",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });

        expect(result.numFailures).toBe(0);
        expect(result.results).toHaveLength(1);
        expect(typeof result.results![0]).toBe("number"); // Auto-increment key
      });

      it("adds multiple items", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        const result = await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
          ],
        });

        expect(result.numFailures).toBe(0);
        expect(result.results).toHaveLength(2);
      });

      it("returns correct lastResult for auto-increment keys", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        // Add multiple items - lastResult should be the key of the last item in the array
        const result = await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
            { name: "Charlie", email: "charlie@test.com", age: 35 },
          ],
        });

        expect(result.numFailures).toBe(0);
        expect(result.results).toHaveLength(3);
        // lastResult should be the key of the last item (Charlie), which is results[2]
        expect(result.lastResult).toBe(result.results![2]);
        // Keys should be sequential for auto-increment
        expect(result.results![2]).toBeGreaterThan(result.results![1] as number);
        expect(result.results![1]).toBeGreaterThan(result.results![0] as number);
      });

      it("reports constraint errors for single-item add (throws)", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        // Add first user
        await table.mutate({
          trans,
          type: "add",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });

        // Try to add duplicate email - single-item operations throw
        await expect(
          table.mutate({
            trans,
            type: "add",
            values: [{ name: "Alice2", email: "alice@test.com", age: 25 }],
          }),
        ).rejects.toThrow();
      });

      it("reports constraint errors for bulk add (returns failures)", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        // Add first user
        await table.mutate({
          trans,
          type: "add",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });

        // Try to add items where one has duplicate email - bulk operations return failures
        const result = await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Bob", email: "bob@test.com", age: 25 },
            { name: "Alice2", email: "alice@test.com", age: 25 }, // Duplicate
          ],
        });

        expect(result.numFailures).toBe(1);
        expect(result.failures).toBeDefined();
        expect(result.failures![1]).toBeDefined(); // Second item failed
      });

      it("works with outbound keys", async () => {
        const trans = core.transaction(["logs"], "readwrite");
        const table = core.table("logs");

        const result = await table.mutate({
          trans,
          type: "add",
          values: [{ message: "test log" }],
        });

        expect(result.numFailures).toBe(0);
        expect(result.results![0]).toBeDefined();
      });

      it("works with explicit keys", async () => {
        const trans = core.transaction(["settings"], "readwrite");
        const table = core.table("settings");

        const result = await table.mutate({
          trans,
          type: "add",
          values: [{ key: "theme", value: "dark" }],
        });

        expect(result.numFailures).toBe(0);
      });
    });

    describe("mutate - put", () => {
      it("inserts new item", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        const result = await table.mutate({
          trans,
          type: "put",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });

        expect(result.numFailures).toBe(0);
      });

      it("returns correct lastResult for multiple puts", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        const result = await table.mutate({
          trans,
          type: "put",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
            { name: "Charlie", email: "charlie@test.com", age: 35 },
          ],
        });

        expect(result.numFailures).toBe(0);
        expect(result.results).toHaveLength(3);
        // lastResult should be the key of the last item (Charlie)
        expect(result.lastResult).toBe(result.results![2]);
      });

      it("updates existing item", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        // Add initial user
        const addResult = await table.mutate({
          trans,
          type: "add",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });
        const id = addResult.results![0];

        // Update with put
        await table.mutate({
          trans,
          type: "put",
          values: [{ id, name: "Alice Updated", email: "alice@test.com", age: 31 }],
        });

        // Verify update
        const user = await table.get({ trans, key: id });
        expect((user as { name: string }).name).toBe("Alice Updated");
        expect((user as { age: number }).age).toBe(31);
      });
    });

    describe("mutate - delete", () => {
      it("deletes by key", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        // Add user
        const addResult = await table.mutate({
          trans,
          type: "add",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });
        const id = addResult.results![0];

        // Delete
        const deleteResult = await table.mutate({
          trans,
          type: "delete",
          keys: [id],
        });

        expect(deleteResult.numFailures).toBe(0);

        // Verify deletion
        const user = await table.get({ trans, key: id });
        expect(user).toBeUndefined();
      });

      it("deletes multiple keys", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        // Add users
        const addResult = await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
          ],
        });

        // Delete both
        await table.mutate({
          trans,
          type: "delete",
          keys: addResult.results!,
        });

        // Verify
        const count = await table.count({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
        });
        expect(count).toBe(0);
      });
    });

    describe("mutate - deleteRange", () => {
      it("deletes all with undefined range", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        // Add users
        await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
          ],
        });

        // Delete all
        await table.mutate({
          trans,
          type: "deleteRange",
          range: keyRangeAll(),
        });

        const count = await table.count({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
        });
        expect(count).toBe(0);
      });
    });

    describe("get", () => {
      it("gets item by key", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        const addResult = await table.mutate({
          trans,
          type: "add",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });

        const user = await table.get({ trans, key: addResult.results![0] });
        expect((user as { name: string }).name).toBe("Alice");
      });

      it("returns undefined for missing key", async () => {
        const trans = core.transaction(["users"], "readonly");
        const table = core.table("users");

        const user = await table.get({ trans, key: 999 });
        expect(user).toBeUndefined();
      });
    });

    describe("getMany", () => {
      it("gets multiple items by keys", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        const addResult = await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
          ],
        });

        const users = await table.getMany({ trans, keys: addResult.results! });
        expect(users).toHaveLength(2);
        expect((users[0] as { name: string }).name).toBe("Alice");
        expect((users[1] as { name: string }).name).toBe("Bob");
      });

      it("returns undefined for missing keys", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        const addResult = await table.mutate({
          trans,
          type: "add",
          values: [{ name: "Alice", email: "alice@test.com", age: 30 }],
        });

        const users = await table.getMany({ trans, keys: [addResult.results![0], 999] });
        expect(users).toHaveLength(2);
        expect((users[0] as { name: string }).name).toBe("Alice");
        expect(users[1]).toBeUndefined();
      });
    });

    describe("count", () => {
      it("counts all records", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
          ],
        });

        const count = await table.count({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
        });
        expect(count).toBe(2);
      });

      it("counts with range", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
            { name: "Charlie", email: "charlie@test.com", age: 35 },
          ],
        });

        // Count keys >= 2
        const count = await table.count({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAbove(1, true)),
        });
        expect(count).toBe(2);
      });
    });

    describe("query", () => {
      let trans: ReturnType<typeof core.transaction>;

      beforeEach(async () => {
        trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
            { name: "Charlie", email: "charlie@test.com", age: 35 },
            { name: "Diana", email: "diana@test.com", age: 25 },
          ],
        });
      });

      it("queries all records", async () => {
        const table = core.table("users");

        // Query for values
        const valuesResult = await table.query({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
          values: true,
        });
        expect(valuesResult.result).toHaveLength(4);

        // Query for keys (values: false returns keys in result)
        const keysResult = await table.query({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
          values: false,
        });
        expect(keysResult.result).toHaveLength(4);
      });

      it("queries with equal range", async () => {
        const table = core.table("users");

        const result = await table.query({
          trans,
          query: indexQuery(table.schema, "name", keyRangeEqual("Alice")),
        });

        expect(result.result).toHaveLength(1);
        expect((result.result[0] as { name: string }).name).toBe("Alice");
      });

      it("queries with range bounds", async () => {
        const table = core.table("users");

        // age >= 30
        const result = await table.query({
          trans,
          query: indexQuery(table.schema, "age", keyRangeRange(30, undefined, false)),
        });

        expect(result.result).toHaveLength(2); // Alice (30) and Charlie (35)
      });

      it("queries with limit", async () => {
        const table = core.table("users");

        const result = await table.query({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
          limit: 2,
        });

        expect(result.result).toHaveLength(2);
      });

      it("queries with offset", async () => {
        const table = core.table("users");

        const result = await table.query({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
          offset: 2,
        });

        expect(result.result).toHaveLength(2);
      });

      it("queries in reverse", async () => {
        const table = core.table("users");

        const result = await table.query({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
          reverse: true,
        });

        expect(result.result).toHaveLength(4);
        // Last added should be first in reverse
        expect((result.result[0] as { name: string }).name).toBe("Diana");
      });

      it("queries with anyOf", async () => {
        const table = core.table("users");

        const result = await table.query({
          trans,
          query: indexQuery(table.schema, "age", keyRangeAnyOf([25, 35])),
        });

        expect(result.result).toHaveLength(3); // Bob, Diana (25), Charlie (35)
      });
    });

    describe("openCursor", () => {
      it("iterates over records", async () => {
        const trans = core.transaction(["users"], "readwrite");
        const table = core.table("users");

        await table.mutate({
          trans,
          type: "add",
          values: [
            { name: "Alice", email: "alice@test.com", age: 30 },
            { name: "Bob", email: "bob@test.com", age: 25 },
          ],
        });

        const collected: unknown[] = [];
        let cursor = await table.openCursor({
          trans,
          query: primaryKeyQuery(table.schema, keyRangeAll()),
        });

        while (cursor) {
          collected.push(cursor.value);
          cursor.continue();
          // Need to wait for next cursor position
          cursor = await table.openCursor({
            trans,
            query: primaryKeyQuery(table.schema, keyRangeAll()),
            offset: collected.length,
            limit: 1,
          });
        }

        expect(collected).toHaveLength(2);
      });
    });
  });

  describe("error handling", () => {
    it("throws for single-item write on readonly transaction", async () => {
      const trans = core.transaction(["users"], "readonly");
      const table = core.table("users");

      // Single-item operations throw instead of returning failures
      await expect(
        table.mutate({
          trans,
          type: "add",
          values: [{ name: "Test", email: "test@test.com", age: 20 }],
        }),
      ).rejects.toThrow(/readonly/);
    });

    it("reports failures for bulk write on readonly transaction", async () => {
      const trans = core.transaction(["users"], "readonly");
      const table = core.table("users");

      // Bulk operations return failures in response
      const result = await table.mutate({
        trans,
        type: "add",
        values: [
          { name: "Test1", email: "test1@test.com", age: 20 },
          { name: "Test2", email: "test2@test.com", age: 25 },
        ],
      });

      expect(result.numFailures).toBe(2);
      expect(result.failures).toBeDefined();
      expect(result.failures![0]).toBeInstanceOf(Error);
      expect(result.failures![0].message).toContain("readonly");
    });

    it("handles getMany with empty array", async () => {
      const trans = core.transaction(["users"], "readonly");
      const table = core.table("users");

      const result = await table.getMany({ trans, keys: [] });
      expect(result).toEqual([]);
    });

    it("handles mutate delete with empty keys array", async () => {
      const trans = core.transaction(["users"], "readwrite");
      const table = core.table("users");

      const result = await table.mutate({
        trans,
        type: "delete",
        keys: [],
      });

      expect(result.numFailures).toBe(0);
    });

    it("handles mutate add with empty values array", async () => {
      const trans = core.transaction(["users"], "readwrite");
      const table = core.table("users");

      const result = await table.mutate({
        trans,
        type: "add",
        values: [],
      });

      expect(result.numFailures).toBe(0);
      expect(result.results).toEqual([]);
    });

    it("handles count on empty table", async () => {
      const trans = core.transaction(["users"], "readonly");
      const table = core.table("users");

      const count = await table.count({
        trans,
        query: primaryKeyQuery(table.schema, keyRangeAll()),
      });
      expect(count).toBe(0);
    });

    it("handles query on empty table", async () => {
      const trans = core.transaction(["users"], "readonly");
      const table = core.table("users");

      // Query for values on empty table
      const valuesResult = await table.query({
        trans,
        query: primaryKeyQuery(table.schema, keyRangeAll()),
        values: true,
      });
      expect(valuesResult.result).toEqual([]);

      // Query for keys on empty table
      const keysResult = await table.query({
        trans,
        query: primaryKeyQuery(table.schema, keyRangeAll()),
        values: false,
      });
      expect(keysResult.result).toEqual([]);
    });
  });

  describe("key range helpers", () => {
    it("keyRangeEqual creates equal range", () => {
      const range = keyRangeEqual("test");
      expect(range.type).toBe(1); // Equal
      expect(range.lower).toBe("test");
    });

    it("keyRangeRange creates bounded range", () => {
      const range = keyRangeRange(1, 10, false, true);
      expect(range.type).toBe(2); // Range
      expect(range.lower).toBe(1);
      expect(range.upper).toBe(10);
      expect(range.lowerOpen).toBe(false);
      expect(range.upperOpen).toBe(true);
    });

    it("keyRangeAnyOf creates any-of range", () => {
      const range = keyRangeAnyOf([1, 2, 3]);
      expect(range.type).toBe(3); // Any
      expect(range.values).toEqual([1, 2, 3]);
    });

    it("keyRangeAbove creates lower-bounded range", () => {
      const range = keyRangeAbove(5);
      expect(range.type).toBe(2); // Range
      expect(range.lower).toBe(5);
      expect(range.upper).toBeUndefined();
      expect(range.lowerOpen).toBe(true);
    });

    it("keyRangeBelow creates upper-bounded range", () => {
      const range = keyRangeBelow(10);
      expect(range.type).toBe(2); // Range
      expect(range.lower).toBeUndefined();
      expect(range.upper).toBe(10);
      expect(range.upperOpen).toBe(true);
    });
  });
});
