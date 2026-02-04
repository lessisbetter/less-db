import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LessDB,
  ConstraintError,
  InvalidStateError,
  type Middleware,
  type DBCore,
  type DBCoreTable,
  type DBCoreTransaction,
  type DBCoreMutateRequest,
} from "../src/index.js";

interface User {
  id?: number;
  name: string;
  email: string;
  age: number;
}

interface Post {
  id?: number;
  userId: number;
  title: string;
  content: string;
}

interface Setting {
  key: string;
  value: unknown;
}

describe("LessDB", () => {
  let db: LessDB;
  let dbName: string;

  beforeEach(() => {
    dbName = `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = new LessDB(dbName);
  });

  afterEach(async () => {
    if (db.isOpen) {
      db.close();
    }
    // Clean up
    await new LessDB(dbName).delete().catch(() => {});
  });

  describe("database lifecycle", () => {
    it("creates and opens database", async () => {
      db.version(1).stores({
        users: "++id, name, email",
      });

      await db.open();

      expect(db.isOpen).toBe(true);
      expect(db.name).toBe(dbName);
      expect(db.verno).toBe(1);
    });

    it("throws when opening without schema", async () => {
      await expect(db.open()).rejects.toThrow("No schema versions defined");
    });

    it("throws when accessing table before open", () => {
      db.version(1).stores({ users: "++id" });

      expect(() => db.table("users")).toThrow(InvalidStateError);
    });

    it("closes database", async () => {
      db.version(1).stores({ users: "++id" });
      await db.open();

      db.close();

      expect(db.isOpen).toBe(false);
    });

    it("deletes database", async () => {
      db.version(1).stores({ users: "++id" });
      await db.open();
      await db.table<User, number>("users").add({ name: "Alice", email: "a@test.com", age: 30 });
      db.close();

      await db.delete();

      // Recreate and verify empty
      const db2 = new LessDB(dbName);
      db2.version(1).stores({ users: "++id" });
      await db2.open();
      const count = await db2.table("users").count();
      expect(count).toBe(0);
      db2.close();
    });

    it("returns table names", async () => {
      db.version(1).stores({
        users: "++id",
        posts: "++id",
        settings: "key",
      });
      await db.open();

      expect(db.tables).toContain("users");
      expect(db.tables).toContain("posts");
      expect(db.tables).toContain("settings");
    });
  });

  describe("schema versioning", () => {
    it("upgrades schema with new table", async () => {
      const db1 = new LessDB(dbName);
      db1.version(1).stores({ users: "++id" });
      await db1.open();
      await db1.table<User, number>("users").add({ name: "Alice", email: "a@test.com", age: 30 });
      db1.close();

      // Upgrade to v2
      const db2 = new LessDB(dbName);
      db2.version(1).stores({ users: "++id" });
      db2.version(2).stores({ users: "++id", posts: "++id" });
      await db2.open();

      expect(db2.tables).toContain("posts");

      // Original data preserved
      const users = await db2.table<User, number>("users").toArray();
      expect(users).toHaveLength(1);

      db2.close();
    });

    it("upgrades schema with new index", async () => {
      const db1 = new LessDB(dbName);
      db1.version(1).stores({ users: "++id, name" });
      await db1.open();
      await db1.table<User, number>("users").add({ name: "Alice", email: "a@test.com", age: 30 });
      db1.close();

      // Upgrade to add email index
      const db2 = new LessDB(dbName);
      db2.version(1).stores({ users: "++id, name" });
      db2.version(2).stores({ users: "++id, name, email" });
      await db2.open();

      // Can query by email
      const users = await db2
        .table<User, number>("users")
        .where("email")
        .equals("a@test.com")
        .toArray();
      expect(users).toHaveLength(1);

      db2.close();
    });

    it("runs upgrade function", async () => {
      const db1 = new LessDB(dbName);
      db1.version(1).stores({ users: "++id, name" });
      await db1.open();
      await db1.table<User, number>("users").add({ name: "Alice", email: "", age: 30 });
      db1.close();

      // Upgrade with migration
      const db2 = new LessDB(dbName);
      db2.version(1).stores({ users: "++id, name" });
      db2
        .version(2)
        .stores({ users: "++id, name, email" })
        .upgrade(async (tx) => {
          const users = tx.table<User, number>("users");
          await users.toCollection().modify((user) => {
            if (!user.email) {
              user.email = `${user.name.toLowerCase()}@migrated.com`;
            }
          });
        });
      await db2.open();

      const user = await db2.table<User, number>("users").where("name").equals("Alice").first();
      expect(user?.email).toBe("alice@migrated.com");

      db2.close();
    });
  });

  describe("table CRUD operations", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, &email, age",
        settings: "key",
      });
      await db.open();
    });

    describe("add", () => {
      it("adds item with auto-increment key", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        expect(typeof id).toBe("number");
        expect(id).toBeGreaterThan(0);
      });

      it("fails on duplicate unique index with ConstraintError", async () => {
        const users = db.table<User, number>("users");
        await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        await expect(users.add({ name: "Bob", email: "alice@test.com", age: 25 })).rejects.toThrow(
          ConstraintError,
        );
      });

      it("adds item with explicit key", async () => {
        const settings = db.table<Setting, string>("settings");
        await settings.add({ key: "theme", value: "dark" });

        const setting = await settings.get("theme");
        expect(setting?.value).toBe("dark");
      });
    });

    describe("get", () => {
      it("gets item by key", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        const user = await users.get(id);

        expect(user?.name).toBe("Alice");
      });

      it("returns undefined for missing key", async () => {
        const users = db.table<User, number>("users");
        const user = await users.get(999);

        expect(user).toBeUndefined();
      });
    });

    describe("put", () => {
      it("inserts new item", async () => {
        const settings = db.table<Setting, string>("settings");
        await settings.put({ key: "theme", value: "dark" });

        const setting = await settings.get("theme");
        expect(setting?.value).toBe("dark");
      });

      it("updates existing item", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        await users.put({ id, name: "Alice Updated", email: "alice@test.com", age: 31 });

        const user = await users.get(id);
        expect(user?.name).toBe("Alice Updated");
        expect(user?.age).toBe(31);
      });
    });

    describe("update", () => {
      it("updates existing item", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        const count = await users.update(id, { age: 31 });

        expect(count).toBe(1);
        const user = await users.get(id);
        expect(user?.age).toBe(31);
        expect(user?.name).toBe("Alice"); // Other fields preserved
      });

      it("returns 0 for non-existent key", async () => {
        const users = db.table<User, number>("users");
        const count = await users.update(999, { age: 31 });

        expect(count).toBe(0);
      });
    });

    describe("delete", () => {
      it("deletes item by key", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        await users.delete(id);

        const user = await users.get(id);
        expect(user).toBeUndefined();
      });
    });

    describe("bulk operations", () => {
      it("bulkAdd adds multiple items", async () => {
        const users = db.table<User, number>("users");
        const keys = await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        expect(keys).toHaveLength(2);
        const count = await users.count();
        expect(count).toBe(2);
      });

      it("bulkPut updates multiple items", async () => {
        const users = db.table<User, number>("users");
        const [id1, id2] = await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        await users.bulkPut([
          { id: id1, name: "Alice Updated", email: "alice@test.com", age: 31 },
          { id: id2, name: "Bob Updated", email: "bob@test.com", age: 26 },
        ]);

        const alice = await users.get(id1);
        expect(alice?.name).toBe("Alice Updated");
      });

      it("bulkGet gets multiple items", async () => {
        const users = db.table<User, number>("users");
        const keys = await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        const results = await users.bulkGet(keys);

        expect(results).toHaveLength(2);
        expect(results[0]?.name).toBe("Alice");
        expect(results[1]?.name).toBe("Bob");
      });

      it("bulkDelete deletes multiple items", async () => {
        const users = db.table<User, number>("users");
        const keys = await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        await users.bulkDelete(keys);

        const count = await users.count();
        expect(count).toBe(0);
      });
    });

    describe("clear", () => {
      it("deletes all items", async () => {
        const users = db.table<User, number>("users");
        await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        await users.clear();

        const count = await users.count();
        expect(count).toBe(0);
      });
    });

    describe("count", () => {
      it("counts all items", async () => {
        const users = db.table<User, number>("users");
        await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        const count = await users.count();
        expect(count).toBe(2);
      });
    });

    describe("toArray", () => {
      it("returns all items", async () => {
        const users = db.table<User, number>("users");
        await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        const all = await users.toArray();
        expect(all).toHaveLength(2);
      });
    });
  });

  describe("queries with WhereClause", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, email, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
        { name: "Charlie", email: "charlie@test.com", age: 35 },
        { name: "Diana", email: "diana@test.com", age: 25 },
        { name: "Eve", email: "eve@test.com", age: 40 },
      ]);
    });

    describe("equals", () => {
      it("finds by exact match", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").equals("Alice").toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Alice");
      });

      it("returns empty for no match", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").equals("Nobody").toArray();

        expect(results).toHaveLength(0);
      });
    });

    describe("anyOf", () => {
      it("finds any of the values", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").anyOf([25, 35]).toArray();

        expect(results).toHaveLength(3); // Bob, Diana (25), Charlie (35)
      });

      it("handles large anyOf arrays efficiently", async () => {
        const users = db.table<User, number>("users");
        // Add more users with different ages
        await users.bulkAdd([
          { name: "User1", email: "u1@test.com", age: 21 },
          { name: "User2", email: "u2@test.com", age: 22 },
          { name: "User3", email: "u3@test.com", age: 23 },
          { name: "User4", email: "u4@test.com", age: 24 },
        ]);

        // Query with multiple values (should execute in parallel)
        const results = await users.where("age").anyOf([21, 22, 23, 24, 25]).toArray();

        expect(results).toHaveLength(6); // 2 at age 25, plus 4 new users
      });
    });

    describe("above/below", () => {
      it("finds values above", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").above(30).toArray();

        expect(results).toHaveLength(2); // Charlie (35), Eve (40)
      });

      it("finds values aboveOrEqual", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").aboveOrEqual(35).toArray();

        expect(results).toHaveLength(2); // Charlie (35), Eve (40)
      });

      it("finds values below", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").below(30).toArray();

        expect(results).toHaveLength(2); // Bob, Diana (25)
      });

      it("finds values belowOrEqual", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").belowOrEqual(25).toArray();

        expect(results).toHaveLength(2);
      });
    });

    describe("between", () => {
      it("finds values in range", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").between(25, 35).toArray();

        // Default: includeLower=true, includeUpper=false
        expect(results).toHaveLength(3); // Bob, Diana (25), Alice (30)
      });

      it("respects inclusive flags", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").between(25, 35, true, true).toArray();

        expect(results).toHaveLength(4); // Bob, Diana (25), Alice (30), Charlie (35)
      });
    });

    describe("startsWith", () => {
      it("finds strings starting with prefix", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").startsWith("A").toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Alice");
      });

      it("handles multi-character prefix", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").startsWith("Ch").toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Charlie");
      });
    });

    describe("startsWithIgnoreCase", () => {
      it("finds strings case-insensitively", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").startsWithIgnoreCase("a").toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Alice");
      });
    });
  });

  describe("Collection operations", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, email, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "alice@test.com", age: 30 },
        { name: "Bob", email: "bob@test.com", age: 25 },
        { name: "Charlie", email: "charlie@test.com", age: 35 },
        { name: "Diana", email: "diana@test.com", age: 25 },
        { name: "Eve", email: "eve@test.com", age: 40 },
      ]);
    });

    describe("filter/and", () => {
      it("filters with predicate", async () => {
        const users = db.table<User, number>("users");
        const results = await users.filter((u) => u.age > 30).toArray();

        expect(results).toHaveLength(2); // Charlie, Eve
      });

      it("chains filters with and", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .above(24)
          .and((u) => u.name.startsWith("B") || u.name.startsWith("D"))
          .toArray();

        expect(results).toHaveLength(2); // Bob, Diana
      });
    });

    describe("limit/offset", () => {
      it("limits results", async () => {
        const users = db.table<User, number>("users");
        const results = await users.toCollection().limit(2).toArray();

        expect(results).toHaveLength(2);
      });

      it("skips with offset", async () => {
        const users = db.table<User, number>("users");
        const results = await users.toCollection().offset(2).toArray();

        expect(results).toHaveLength(3);
      });

      it("combines limit and offset", async () => {
        const users = db.table<User, number>("users");
        const results = await users.toCollection().offset(1).limit(2).toArray();

        expect(results).toHaveLength(2);
      });
    });

    describe("reverse", () => {
      it("reverses order", async () => {
        const users = db.table<User, number>("users");
        const normal = await users.toCollection().toArray();
        const reversed = await users.toCollection().reverse().toArray();

        expect(reversed[0].id).toBe(normal[normal.length - 1].id);
      });
    });

    describe("first/last", () => {
      it("gets first item", async () => {
        const users = db.table<User, number>("users");
        const first = await users.toCollection().first();

        expect(first).toBeDefined();
        expect(first?.name).toBe("Alice");
      });

      it("gets last item", async () => {
        const users = db.table<User, number>("users");
        const last = await users.toCollection().last();

        expect(last).toBeDefined();
        expect(last?.name).toBe("Eve");
      });
    });

    describe("count", () => {
      it("counts matching items", async () => {
        const users = db.table<User, number>("users");
        const count = await users.where("age").equals(25).count();

        expect(count).toBe(2);
      });

      it("counts with filter", async () => {
        const users = db.table<User, number>("users");
        const count = await users.filter((u) => u.age > 30).count();

        expect(count).toBe(2);
      });
    });

    describe("keys/primaryKeys", () => {
      it("returns primary keys", async () => {
        const users = db.table<User, number>("users");
        const keys = await users.where("age").equals(25).primaryKeys();

        expect(keys).toHaveLength(2);
        expect(typeof keys[0]).toBe("number");
      });
    });

    describe("each", () => {
      it("iterates over items", async () => {
        const users = db.table<User, number>("users");
        const names: string[] = [];

        await users.toCollection().each((u) => names.push(u.name));

        expect(names).toHaveLength(5);
      });
    });

    describe("sortBy", () => {
      it("sorts by property", async () => {
        const users = db.table<User, number>("users");
        const sorted = await users.toCollection().sortBy("name");

        expect(sorted[0].name).toBe("Alice");
        expect(sorted[4].name).toBe("Eve");
      });
    });

    describe("modify", () => {
      it("modifies with object", async () => {
        const users = db.table<User, number>("users");
        const count = await users.where("age").equals(25).modify({ age: 26 });

        expect(count).toBe(2);

        const updated = await users.where("age").equals(26).toArray();
        expect(updated).toHaveLength(2);
      });

      it("modifies with function", async () => {
        const users = db.table<User, number>("users");
        await users.toCollection().modify((u) => {
          u.name = u.name.toUpperCase();
        });

        const alice = await users.where("name").equals("ALICE").first();
        expect(alice).toBeDefined();
      });
    });

    describe("delete", () => {
      it("deletes matching items", async () => {
        const users = db.table<User, number>("users");
        const deleted = await users.where("age").equals(25).delete();

        expect(deleted).toBe(2);

        const remaining = await users.count();
        expect(remaining).toBe(3);
      });
    });
  });

  describe("transactions", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
        logs: "++id, action",
      });
      await db.open();
    });

    it("executes transaction successfully", async () => {
      const result = await db.transaction("rw", ["users", "logs"], async (tx) => {
        const users = tx.table<User, number>("users");
        const logs = tx.table<{ id?: number; action: string; userId: number }, number>("logs");

        const userId = await users.add({ name: "Alice", email: "a@test.com", age: 30 });
        await logs.add({ action: "user_created", userId });

        return userId;
      });

      expect(typeof result).toBe("number");

      const users = await db.table("users").toArray();
      const logs = await db.table("logs").toArray();
      expect(users).toHaveLength(1);
      expect(logs).toHaveLength(1);
    });

    it("rolls back on error", async () => {
      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          const users = tx.table<User, number>("users");
          await users.add({ name: "Alice", email: "a@test.com", age: 30 });
          throw new Error("Intentional failure");
        }),
      ).rejects.toThrow("Intentional failure");

      const users = await db.table("users").toArray();
      expect(users).toHaveLength(0);
    });

    it("supports readonly transactions", async () => {
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      const result = await db.transaction("r", ["users"], async (tx) => {
        return tx.table<User, number>("users").toArray();
      });

      expect(result).toHaveLength(1);
    });
  });

  describe("table hooks", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();
    });

    it("fires creating hook", async () => {
      const users = db.table<User & { createdAt?: number }, number>("users");
      let hookCalled = false;

      users.hook.creating.subscribe((key, obj) => {
        hookCalled = true;
        obj.createdAt = Date.now();
      });

      const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      expect(hookCalled).toBe(true);

      const user = await users.get(id);
      expect(user?.createdAt).toBeDefined();
    });

    it("fires reading hook", async () => {
      const users = db.table<User & { fullInfo?: string }, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      users.hook.reading.subscribe((obj) => ({
        ...obj,
        fullInfo: `${obj.name} (${obj.age})`,
      }));

      const user = await users.get(id);
      expect(user?.fullInfo).toBe("Alice (30)");
    });
  });

  describe("events", () => {
    it("fires ready event", async () => {
      let readyFired = false;

      db.version(1).stores({ users: "++id" });
      db.on("ready", () => {
        readyFired = true;
      });

      await db.open();

      expect(readyFired).toBe(true);
    });

    it("fires close event", async () => {
      let closeFired = false;

      db.version(1).stores({ users: "++id" });
      await db.open();

      db.on("close", () => {
        closeFired = true;
      });

      db.close();

      expect(closeFired).toBe(true);
    });
  });

  describe("Table.upsert", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, email",
      });
      await db.open();
    });

    it("inserts new item when key does not exist", async () => {
      const users = db.table<User, number>("users");
      const key = await users.upsert({ name: "Alice", email: "a@test.com", age: 30 });

      const user = await users.get(key);
      expect(user?.name).toBe("Alice");
    });

    it("updates existing item when key exists", async () => {
      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      await users.upsert({ id, name: "Alice Updated", email: "updated@test.com", age: 31 });

      const user = await users.get(id);
      expect(user?.name).toBe("Alice Updated");
      expect(user?.age).toBe(31);
    });

    it("merges partial changes on existing item", async () => {
      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      await users.upsert({ id, age: 35 } as Partial<User>);

      const user = await users.get(id);
      expect(user?.name).toBe("Alice"); // Unchanged
      expect(user?.age).toBe(35); // Updated
    });
  });

  describe("Table.bulkUpdate", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();
    });

    it("updates multiple items", async () => {
      const users = db.table<User, number>("users");
      const [id1, id2, id3] = await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
      ]);

      const updated = await users.bulkUpdate([
        { key: id1, changes: { age: 26 } },
        { key: id2, changes: { age: 31 } },
      ]);

      expect(updated).toBe(2);

      const alice = await users.get(id1);
      const bob = await users.get(id2);
      expect(alice?.age).toBe(26);
      expect(bob?.age).toBe(31);
    });

    it("returns 0 for non-existent keys", async () => {
      const users = db.table<User, number>("users");

      const updated = await users.bulkUpdate([{ key: 999, changes: { age: 99 } }]);

      expect(updated).toBe(0);
    });

    it("updates only existing items", async () => {
      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com", age: 25 });

      const updated = await users.bulkUpdate([
        { key: id, changes: { age: 30 } },
        { key: 999, changes: { age: 99 } }, // Non-existent
      ]);

      expect(updated).toBe(1);
    });
  });

  describe("WhereClause extensions", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "ALICE", email: "upper@test.com", age: 26 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
      ]);
    });

    it("anyOfIgnoreCase matches case-insensitively", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("name").anyOfIgnoreCase(["alice", "BOB"]).toArray();

      expect(results).toHaveLength(3); // Alice, ALICE, Bob
    });

    it("startsWithAnyOf matches multiple prefixes", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("name").startsWithAnyOf(["Al", "Ch"]).toArray();

      expect(results).toHaveLength(2); // Alice, Charlie (ALICE doesn't start with Al)
    });

    it("startsWithAnyOfIgnoreCase matches case-insensitively", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("name").startsWithAnyOfIgnoreCase(["al", "ch"]).toArray();

      expect(results).toHaveLength(3); // Alice, ALICE, Charlie
    });

    it("inAnyRange matches values in any range", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .where("age")
        .inAnyRange([
          [20, 27], // Alice (25), ALICE (26)
          [35, 45], // Charlie (35), Dave (40)
        ])
        .toArray();

      expect(results).toHaveLength(4);
    });
  });

  describe("Collection.or", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
      ]);
    });

    it("combines queries with OR logic", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").below(30).or("age").above(40).toArray();

      // Alice (25) OR Eve (45)
      expect(results).toHaveLength(2);
      expect(results.map((u) => u.name).sort()).toEqual(["Alice", "Eve"]);
    });

    it("deduplicates results", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").equals(25).or("name").equals("Alice").toArray();

      // Should only have Alice once
      expect(results).toHaveLength(1);
    });

    it("throws on modify() with OR", async () => {
      const users = db.table<User, number>("users");

      await expect(
        users.where("age").below(30).or("age").above(40).modify({ age: 99 }),
      ).rejects.toThrow("modify() does not support OR queries");
    });

    it("throws on delete() with OR", async () => {
      const users = db.table<User, number>("users");

      await expect(users.where("age").below(30).or("age").above(40).delete()).rejects.toThrow(
        "delete() does not support OR queries",
      );
    });
  });

  describe("Collection extensions", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
      ]);
    });

    it("until stops iteration at predicate", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .orderBy("age")
        .until((u) => u.age >= 35)
        .toArray();

      // Alice (25), Bob (30) - stops before Charlie (35)
      expect(results).toHaveLength(2);
      expect(results.map((u) => u.name)).toEqual(["Alice", "Bob"]);
    });

    it("until includes stop item when specified", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .orderBy("age")
        .until((u) => u.age >= 35, true)
        .toArray();

      // Alice (25), Bob (30), Charlie (35)
      expect(results).toHaveLength(3);
    });

    it("clone creates independent collection", async () => {
      const users = db.table<User, number>("users");
      const collection = users.toCollection().limit(3);
      const cloned = collection.clone().limit(2);

      const original = await collection.toArray();
      const clonedResults = await cloned.toArray();

      expect(original).toHaveLength(3);
      expect(clonedResults).toHaveLength(2);
    });

    it("desc is alias for reverse", async () => {
      const users = db.table<User, number>("users");
      const descResults = await users.orderBy("age").desc().limit(2).toArray();
      const reverseResults = await users.orderBy("age").reverse().limit(2).toArray();

      expect(descResults).toEqual(reverseResults);
      expect(descResults[0].name).toBe("Eve"); // Oldest first
    });

    it("firstKey returns first key", async () => {
      const users = db.table<User, number>("users");
      const key = await users.orderBy("age").firstKey();

      expect(key).toBeDefined();
    });

    it("lastKey returns last key", async () => {
      const users = db.table<User, number>("users");
      const key = await users.orderBy("age").lastKey();

      expect(key).toBeDefined();
    });

    it("eachKey iterates over keys", async () => {
      const users = db.table<User, number>("users");
      const keys: number[] = [];

      await users
        .toCollection()
        .limit(3)
        .eachKey((key) => keys.push(key));

      expect(keys).toHaveLength(3);
    });

    it("eachPrimaryKey iterates over primary keys", async () => {
      const users = db.table<User, number>("users");
      const keys: number[] = [];

      await users
        .toCollection()
        .limit(3)
        .eachPrimaryKey((key) => keys.push(key));

      expect(keys).toHaveLength(3);
    });

    it("raw returns a collection", async () => {
      // raw() is used to skip reading hooks, but reading hooks currently only
      // apply to get/bulkGet, not toArray. This test verifies raw() exists and works.
      const users = db.table<User, number>("users");

      const rawResults = await users.toCollection().limit(2).raw().toArray();

      expect(rawResults).toHaveLength(2);
    });
  });

  describe("middleware", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
    });

    it("registers middleware", async () => {
      let middlewareCalled = false;

      const middleware: Middleware = {
        stack: "dbcore",
        name: "test-middleware",
        level: 1,
        create: (downCore: DBCore) => {
          middlewareCalled = true;
          return {};
        },
      };

      db.use(middleware);
      await db.open();

      expect(middlewareCalled).toBe(true);
    });

    it("allows middleware to wrap operations", async () => {
      const operations: string[] = [];

      const middleware: Middleware = {
        stack: "dbcore",
        name: "logging-middleware",
        create: (downCore: DBCore) => {
          const wrappedTables = new Map<string, DBCoreTable>();

          return {
            table: (name: string): DBCoreTable => {
              if (!wrappedTables.has(name)) {
                const downTable = downCore.table(name);
                wrappedTables.set(name, {
                  ...downTable,
                  get: async (req) => {
                    operations.push(`get:${name}:${req.key}`);
                    return downTable.get(req);
                  },
                  mutate: async (req) => {
                    operations.push(`mutate:${name}:${req.type}`);
                    return downTable.mutate(req);
                  },
                });
              }
              return wrappedTables.get(name)!;
            },
          };
        },
      };

      db.use(middleware);
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });
      await users.get(id);

      expect(operations).toContain("mutate:users:add");
      expect(operations).toContain("get:users:1");
    });

    it("unregisters middleware", async () => {
      let middlewareCalled = false;

      const middleware: Middleware = {
        stack: "dbcore",
        name: "test-middleware",
        create: (downCore: DBCore) => {
          middlewareCalled = true;
          return {};
        },
      };

      db.use(middleware);
      db.unuse(middleware);
      await db.open();

      // Middleware should not be called after unuse
      expect(middlewareCalled).toBe(false);
    });

    it("applies middleware in level order", async () => {
      const order: string[] = [];

      const highLevel: Middleware = {
        stack: "dbcore",
        name: "high-level",
        level: 10,
        create: (downCore: DBCore) => {
          order.push("high");
          return {};
        },
      };

      const lowLevel: Middleware = {
        stack: "dbcore",
        name: "low-level",
        level: 1,
        create: (downCore: DBCore) => {
          order.push("low");
          return {};
        },
      };

      db.use(highLevel);
      db.use(lowLevel);

      await db.open();

      // Low level should be applied first (closer to IndexedDB)
      expect(order).toEqual(["low", "high"]);
    });
  });

  describe("empty input handling", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();
    });

    it("bulkAdd with empty array returns empty keys", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkAdd([]);
      expect(keys).toEqual([]);
    });

    it("bulkGet with empty array returns empty array", async () => {
      const users = db.table<User, number>("users");
      const results = await users.bulkGet([]);
      expect(results).toEqual([]);
    });

    it("bulkPut with empty array returns empty keys", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.bulkPut([]);
      expect(keys).toEqual([]);
    });

    it("bulkDelete with empty array succeeds", async () => {
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      await users.bulkDelete([]);

      // Original data should still exist
      const count = await users.count();
      expect(count).toBe(1);
    });

    it("anyOf with empty array returns no results", async () => {
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      const results = await users.where("age").anyOf([]).toArray();
      expect(results).toEqual([]);
    });

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
      const first = await users.toCollection().first();
      expect(first).toBeUndefined();
    });

    it("last on empty table returns undefined", async () => {
      const users = db.table<User, number>("users");
      const last = await users.toCollection().last();
      expect(last).toBeUndefined();
    });

    it("primaryKeys on empty table returns empty array", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.toCollection().primaryKeys();
      expect(keys).toEqual([]);
    });
  });

  describe("bfcache handling", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
    });

    it("setupBfCacheHandling returns this for chaining", async () => {
      const result = db.setupBfCacheHandling();
      expect(result).toBe(db);
    });

    it("_requery exists and is callable", async () => {
      await db.open();
      // Should not throw
      expect(() => db._requery()).not.toThrow();
    });
  });

  describe("Collection.or() clause operations", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
      ]);
    });

    describe("or().notEqual", () => {
      it("combines base query with notEqual OR clause", async () => {
        const users = db.table<User, number>("users");
        // age < 30 OR name != "Dave"
        const results = await users.where("age").below(30).or("name").notEqual("Dave").toArray();

        // Alice (25) from first clause, plus Bob, Charlie, Eve from notEqual Dave (deduplicated)
        expect(results).toHaveLength(4);
        expect(results.map((u) => u.name).sort()).toEqual(["Alice", "Bob", "Charlie", "Eve"]);
      });
    });

    describe("or().anyOf", () => {
      it("combines base query with anyOf OR clause", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(25).or("age").anyOf([35, 45]).toArray();

        expect(results).toHaveLength(3); // Alice (25), Charlie (35), Eve (45)
        expect(results.map((u) => u.name).sort()).toEqual(["Alice", "Charlie", "Eve"]);
      });

      it("returns base collection when anyOf has empty array", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(25).or("age").anyOf([]).toArray();

        expect(results).toHaveLength(1); // Only Alice from base query
      });
    });

    describe("or().noneOf", () => {
      it("combines base query with noneOf OR clause", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(25)
          .or("age")
          .noneOf([25, 30, 35])
          .toArray();

        // Alice (25) from base, plus Dave (40), Eve (45) from noneOf
        expect(results).toHaveLength(3);
        expect(results.map((u) => u.name).sort()).toEqual(["Alice", "Dave", "Eve"]);
      });
    });

    describe("or().above and or().aboveOrEqual", () => {
      it("combines with above", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(25).or("age").above(40).toArray();

        expect(results).toHaveLength(2); // Alice (25), Eve (45)
        expect(results.map((u) => u.name).sort()).toEqual(["Alice", "Eve"]);
      });

      it("combines with aboveOrEqual", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(25).or("age").aboveOrEqual(45).toArray();

        expect(results).toHaveLength(2); // Alice (25), Eve (45)
      });
    });

    describe("or().below and or().belowOrEqual", () => {
      it("combines with below", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(45).or("age").below(30).toArray();

        expect(results).toHaveLength(2); // Alice (25), Eve (45)
      });

      it("combines with belowOrEqual", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(45).or("age").belowOrEqual(25).toArray();

        expect(results).toHaveLength(2); // Alice (25), Eve (45)
      });
    });

    describe("or().between", () => {
      it("combines with between (default bounds)", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(45).or("age").between(25, 35).toArray();

        // Eve (45), plus Alice (25), Bob (30) - default excludes upper bound
        expect(results).toHaveLength(3);
      });

      it("combines with between (custom bounds)", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("age")
          .between(25, 35, true, true)
          .toArray();

        // Eve (45), plus Alice (25), Bob (30), Charlie (35)
        expect(results).toHaveLength(4);
      });
    });

    describe("or().startsWith", () => {
      it("combines with startsWith", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(45).or("name").startsWith("A").toArray();

        expect(results).toHaveLength(2); // Eve (45), Alice (starts with A)
        expect(results.map((u) => u.name).sort()).toEqual(["Alice", "Eve"]);
      });

      it("handles empty prefix in OR clause", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(45).or("name").startsWith("").toArray();

        // Eve (45) plus all others (empty prefix matches all)
        expect(results).toHaveLength(5);
      });
    });

    describe("or().startsWithIgnoreCase", () => {
      it("combines with startsWithIgnoreCase", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("name")
          .startsWithIgnoreCase("a")
          .toArray();

        expect(results).toHaveLength(2); // Eve, Alice
      });
    });

    describe("or().equalsIgnoreCase", () => {
      it("combines with equalsIgnoreCase", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("name")
          .equalsIgnoreCase("ALICE")
          .toArray();

        expect(results).toHaveLength(2); // Eve, Alice
      });
    });

    describe("or().anyOfIgnoreCase", () => {
      it("combines with anyOfIgnoreCase", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("name")
          .anyOfIgnoreCase(["ALICE", "BOB"])
          .toArray();

        expect(results).toHaveLength(3); // Eve, Alice, Bob
      });

      it("returns base collection when anyOfIgnoreCase has empty array", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(25)
          .or("name")
          .anyOfIgnoreCase([])
          .toArray();

        expect(results).toHaveLength(1); // Only Alice
      });
    });

    describe("or().startsWithAnyOf", () => {
      it("combines with single prefix", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("name")
          .startsWithAnyOf(["A"])
          .toArray();

        expect(results).toHaveLength(2); // Eve, Alice
      });

      it("combines with multiple prefixes", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("name")
          .startsWithAnyOf(["A", "B"])
          .toArray();

        expect(results).toHaveLength(3); // Eve, Alice, Bob
      });

      it("returns base collection when startsWithAnyOf has empty array", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(25)
          .or("name")
          .startsWithAnyOf([])
          .toArray();

        expect(results).toHaveLength(1); // Only Alice
      });
    });

    describe("or().startsWithAnyOfIgnoreCase", () => {
      it("combines with case-insensitive prefixes", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("name")
          .startsWithAnyOfIgnoreCase(["a", "b"])
          .toArray();

        expect(results).toHaveLength(3); // Eve, Alice, Bob
      });

      it("returns base collection when empty array", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(25)
          .or("name")
          .startsWithAnyOfIgnoreCase([])
          .toArray();

        expect(results).toHaveLength(1);
      });
    });

    describe("or().inAnyRange", () => {
      it("combines with single range", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(45)
          .or("age")
          .inAnyRange([[25, 30]])
          .toArray();

        // Eve (45), Alice (25)
        expect(results).toHaveLength(2);
      });

      it("combines with multiple ranges", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("name")
          .equals("Eve")
          .or("age")
          .inAnyRange([
            [20, 26],
            [34, 36],
          ])
          .toArray();

        // Eve, Alice (25), Charlie (35)
        expect(results).toHaveLength(3);
      });

      it("respects includeUppers option", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("name")
          .equals("Eve")
          .or("age")
          .inAnyRange([[25, 30]], { includeLowers: true, includeUppers: true })
          .toArray();

        // Eve, Alice (25), Bob (30)
        expect(results).toHaveLength(3);
      });

      it("returns base collection when empty ranges array", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").equals(25).or("age").inAnyRange([]).toArray();

        expect(results).toHaveLength(1); // Only Alice
      });
    });

    describe("chained OR operations", () => {
      it("supports multiple OR clauses", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(25)
          .or("age")
          .equals(35)
          .or("age")
          .equals(45)
          .toArray();

        expect(results).toHaveLength(3); // Alice, Charlie, Eve
      });

      it("OR query works when first clause matches nothing", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .equals(999) // No match
          .or("age")
          .equals(25)
          .toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Alice");
      });
    });
  });

  describe("Collection.sortBy edge cases", () => {
    interface NestedUser {
      id?: number;
      name: string;
      profile: {
        location: {
          city: string;
        };
        score: number;
      };
    }

    beforeEach(async () => {
      db.version(1).stores({
        nestedUsers: "++id",
      });
      await db.open();

      const users = db.table<NestedUser, number>("nestedUsers");
      await users.bulkAdd([
        { name: "Alice", profile: { location: { city: "NYC" }, score: 100 } },
        { name: "Bob", profile: { location: { city: "LA" }, score: 50 } },
        { name: "Charlie", profile: { location: { city: "Boston" }, score: 75 } },
      ]);
    });

    it("sorts by nested path", async () => {
      const users = db.table<NestedUser, number>("nestedUsers");
      const sorted = await users.toCollection().sortBy("profile.score");

      expect(sorted[0].name).toBe("Bob"); // 50
      expect(sorted[1].name).toBe("Charlie"); // 75
      expect(sorted[2].name).toBe("Alice"); // 100
    });

    it("sorts by deeply nested path", async () => {
      const users = db.table<NestedUser, number>("nestedUsers");
      const sorted = await users.toCollection().sortBy("profile.location.city");

      expect(sorted[0].profile.location.city).toBe("Boston");
      expect(sorted[1].profile.location.city).toBe("LA");
      expect(sorted[2].profile.location.city).toBe("NYC");
    });

    it("handles missing nested properties", async () => {
      const users = db.table<NestedUser, number>("nestedUsers");
      await users.add({ name: "Dave", profile: { location: { city: "Miami" }, score: 0 } });

      // Should not throw on non-existent path
      const sorted = await users.toCollection().sortBy("profile.nonexistent.path");
      expect(sorted).toHaveLength(4);
    });
  });

  describe("Collection.modify edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
      ]);
    });

    it("modifies with filter and limit", async () => {
      const users = db.table<User, number>("users");
      const count = await users
        .toCollection()
        .filter((u) => u.age >= 30)
        .limit(2)
        .modify({ age: 99 });

      expect(count).toBe(2);

      const modified = await users.where("age").equals(99).toArray();
      expect(modified).toHaveLength(2);
    });

    it("modifies with filter and offset", async () => {
      const users = db.table<User, number>("users");
      const count = await users
        .toCollection()
        .filter((u) => u.age >= 30)
        .offset(1)
        .modify({ age: 99 });

      // 4 users with age >= 30, skip first one, modify remaining 3
      expect(count).toBe(3);
    });

    it("modifies with filter, offset, and limit combined", async () => {
      const users = db.table<User, number>("users");
      const count = await users
        .toCollection()
        .filter((u) => u.age >= 25)
        .offset(1)
        .limit(2)
        .modify({ age: 99 });

      expect(count).toBe(2);
    });

    it("modifies with function that returns partial object", async () => {
      const users = db.table<User, number>("users");
      const count = await users
        .where("age")
        .equals(25)
        .modify((u) => ({ age: u.age + 10 }));

      expect(count).toBe(1);

      const alice = await users.where("name").equals("Alice").first();
      expect(alice?.age).toBe(35);
    });

    it("modify function mutates in place", async () => {
      const users = db.table<User, number>("users");
      await users
        .where("age")
        .equals(25)
        .modify((u) => {
          u.age = 100;
        });

      const alice = await users.where("name").equals("Alice").first();
      expect(alice?.age).toBe(100);
    });

    it("modify returns 0 when no items match", async () => {
      const users = db.table<User, number>("users");
      const count = await users.where("age").equals(999).modify({ age: 1 });

      expect(count).toBe(0);
    });
  });

  describe("Collection.delete edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
      ]);
    });

    it("deletes with filter", async () => {
      const users = db.table<User, number>("users");
      const deleted = await users
        .toCollection()
        .filter((u) => u.age > 35)
        .delete();

      expect(deleted).toBe(2); // Dave, Eve
      expect(await users.count()).toBe(3);
    });

    it("deletes with filter and limit", async () => {
      const users = db.table<User, number>("users");
      const deleted = await users
        .toCollection()
        .filter((u) => u.age >= 30)
        .limit(2)
        .delete();

      expect(deleted).toBe(2);
      expect(await users.count()).toBe(3);
    });

    it("deletes with filter and offset", async () => {
      const users = db.table<User, number>("users");
      const deleted = await users
        .toCollection()
        .filter((u) => u.age >= 30)
        .offset(1)
        .delete();

      expect(deleted).toBe(3); // Skip first of 4 matching, delete remaining 3
      expect(await users.count()).toBe(2);
    });

    it("deletes using index query with filter", async () => {
      const users = db.table<User, number>("users");
      const deleted = await users
        .where("age")
        .above(25)
        .filter((u) => u.name.startsWith("C") || u.name.startsWith("D"))
        .delete();

      expect(deleted).toBe(2); // Charlie, Dave
    });

    it("deletes with index and limit", async () => {
      const users = db.table<User, number>("users");
      const deleted = await users.where("age").above(25).limit(2).delete();

      expect(deleted).toBe(2);
    });

    it("delete returns 0 when no items match", async () => {
      const users = db.table<User, number>("users");
      const deleted = await users.where("age").equals(999).delete();

      expect(deleted).toBe(0);
    });

    it("delete works with range query (no filter)", async () => {
      const users = db.table<User, number>("users");
      // When deleting on primary key range without filter, uses deleteRange
      const deleted = await users.toCollection().delete();

      expect(deleted).toBe(5);
      expect(await users.count()).toBe(0);
    });
  });

  describe("outbound key tables", () => {
    // Outbound key tables have schema like "++" where the key is auto-generated
    // but not stored in the object itself. This means we can't extract the
    // primary key from values, which affects modify() and delete() operations.

    interface LogEntry {
      message: string;
      level: string;
    }

    beforeEach(async () => {
      db.version(1).stores({
        logs: "++", // Outbound auto-increment key
      });
      await db.open();

      const logs = db.table<LogEntry, number>("logs");
      await logs.bulkAdd([
        { message: "Info message", level: "info" },
        { message: "Warning message", level: "warn" },
        { message: "Error message", level: "error" },
      ]);
    });

    it("throws on modify() for outbound key tables", async () => {
      const logs = db.table<LogEntry, number>("logs");

      await expect(logs.toCollection().modify({ level: "debug" })).rejects.toThrow(/outbound/i);
    });

    it("throws on delete() with filter for outbound key tables", async () => {
      const logs = db.table<LogEntry, number>("logs");

      // delete() with filter needs to extract keys from values
      await expect(
        logs
          .toCollection()
          .filter((log) => log.level === "error")
          .delete(),
      ).rejects.toThrow(/outbound/i);
    });

    it("allows delete() without filter on outbound key tables", async () => {
      const logs = db.table<LogEntry, number>("logs");

      // delete() without filter uses deleteRange which doesn't need keys
      const deleted = await logs.toCollection().delete();
      expect(deleted).toBe(3);
    });
  });

  describe("WhereClause edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
      ]);
    });

    describe("notEqual", () => {
      it("returns items not equal to value", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").notEqual(30).toArray();

        expect(results).toHaveLength(2);
        expect(results.map((u) => u.name).sort()).toEqual(["Alice", "Charlie"]);
      });

      it("notEqual uses index key not primary key", async () => {
        const users = db.table<User, number>("users");
        // If notEqual incorrectly used primary key, this would fail
        // Alice has id=1 and age=25, Bob has id=2 and age=30, Charlie has id=3 and age=35
        // Querying notEqual(1) on age should return ALL since no one has age=1
        const results = await users.where("age").notEqual(1).toArray();
        expect(results).toHaveLength(3);
      });
    });

    describe("noneOf", () => {
      it("returns items not in the set", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").noneOf([25, 35]).toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Bob");
      });

      it("returns all items when noneOf has empty array", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("age").noneOf([]).toArray();

        expect(results).toHaveLength(3);
      });
    });

    describe("equalsIgnoreCase", () => {
      it("finds exact match case-insensitively", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").equalsIgnoreCase("ALICE").toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Alice");
      });

      it("returns empty when no case-insensitive match", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").equalsIgnoreCase("NOBODY").toArray();

        expect(results).toHaveLength(0);
      });
    });

    describe("startsWithAnyOf edge cases", () => {
      it("handles single prefix correctly", async () => {
        const users = db.table<User, number>("users");
        const results = await users.where("name").startsWithAnyOf(["B"]).toArray();

        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Bob");
      });
    });

    describe("inAnyRange with options", () => {
      it("respects excludeLowers option", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .inAnyRange([[25, 35]], { includeLowers: false })
          .toArray();

        // Excludes 25, includes 30, excludes 35 (default)
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Bob");
      });

      it("respects includeUppers option", async () => {
        const users = db.table<User, number>("users");
        const results = await users
          .where("age")
          .inAnyRange([[25, 35]], { includeUppers: true })
          .toArray();

        // Includes 25, 30, 35
        expect(results).toHaveLength(3);
      });
    });
  });

  describe("Complex query combinations", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
        { name: "Frank", email: "f@test.com", age: 50 },
      ]);
    });

    it("filter + limit + offset", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .toCollection()
        .filter((u) => u.age >= 30)
        .offset(1)
        .limit(2)
        .toArray();

      expect(results).toHaveLength(2);
    });

    it("filter + reverse + limit", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .orderBy("age")
        .filter((u) => u.age >= 30)
        .reverse()
        .limit(2)
        .toArray();

      // Reverse means highest ages first
      expect(results[0].name).toBe("Frank"); // 50
      expect(results[1].name).toBe("Eve"); // 45
    });

    it("filter + until combination", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .orderBy("age")
        .filter((u) => u.age >= 30)
        .until((u) => u.age >= 45)
        .toArray();

      // Starts at 30 (Bob), stops before 45
      expect(results.map((u) => u.name)).toEqual(["Bob", "Charlie", "Dave"]);
    });

    it("filter + until + includeStopItem", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .orderBy("age")
        .filter((u) => u.age >= 30)
        .until((u) => u.age >= 45, true)
        .toArray();

      // Includes Eve (45) as stop item
      expect(results.map((u) => u.name)).toEqual(["Bob", "Charlie", "Dave", "Eve"]);
    });

    it("reverse + offset + limit", async () => {
      const users = db.table<User, number>("users");
      const results = await users.toCollection().reverse().offset(1).limit(2).toArray();

      expect(results).toHaveLength(2);
    });

    it("index query + filter + limit", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .where("age")
        .above(25)
        .filter((u) => u.name.length <= 4) // Bob, Dave, Eve
        .limit(2)
        .toArray();

      expect(results).toHaveLength(2);
    });

    it("chained filter predicates", async () => {
      const users = db.table<User, number>("users");
      const results = await users
        .toCollection()
        .filter((u) => u.age >= 30)
        .and((u) => u.age <= 45)
        .and((u) => u.name.length <= 4)
        .toArray();

      // Bob (30, 3 chars), Dave (40, 4 chars), Eve (45, 3 chars)
      expect(results).toHaveLength(3);
    });
  });

  describe("OR queries with primaryKeys() and limit", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
      ]);
    });

    it("primaryKeys with OR query", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.where("age").equals(25).or("age").equals(45).primaryKeys();

      expect(keys).toHaveLength(2);
    });

    it("primaryKeys with OR query deduplicates", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.where("age").equals(25).or("name").equals("Alice").primaryKeys();

      // Alice matches both clauses, should appear once
      expect(keys).toHaveLength(1);
    });

    it("OR query respects limit after merge", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").below(35).or("age").above(40).limit(3).toArray();

      // Could match Alice (25), Bob (30), Eve (45) - limited to 3
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("primaryKeys with OR respects limit after merge", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.where("age").below(40).or("age").above(30).limit(3).primaryKeys();

      expect(keys.length).toBeLessThanOrEqual(3);
    });

    it("count with OR query", async () => {
      const users = db.table<User, number>("users");
      const count = await users.where("age").equals(25).or("age").equals(45).count();

      expect(count).toBe(2);
    });
  });

  describe("Negative cases and error handling", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, &email, name",
      });
      await db.open();
    });

    describe("Constraint violations", () => {
      it("add throws ConstraintError on duplicate unique index", async () => {
        const users = db.table<User, number>("users");
        await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        await expect(users.add({ name: "Bob", email: "alice@test.com", age: 25 })).rejects.toThrow(
          ConstraintError,
        );
      });

      it("bulkAdd throws ConstraintError with details on failure", async () => {
        const users = db.table<User, number>("users");
        await users.add({ name: "Alice", email: "alice@test.com", age: 30 });

        await expect(
          users.bulkAdd([
            { name: "Bob", email: "bob@test.com", age: 25 },
            { name: "Charlie", email: "alice@test.com", age: 35 }, // Duplicate
          ]),
        ).rejects.toThrow(ConstraintError);
      });

      it("bulkPut throws ConstraintError on unique constraint violation", async () => {
        const users = db.table<User, number>("users");
        const [id1] = await users.bulkAdd([
          { name: "Alice", email: "alice@test.com", age: 30 },
          { name: "Bob", email: "bob@test.com", age: 25 },
        ]);

        // Alice and Bob both exist - try to change Alice's email to Bob's email
        // This should throw since Bob still has that email (unique constraint)
        await expect(
          users.bulkPut([{ id: id1, name: "Alice", email: "bob@test.com", age: 30 }]),
        ).rejects.toThrow(ConstraintError);
      });
    });

    describe("Empty inputs", () => {
      it("bulkUpdate with empty array returns 0", async () => {
        const users = db.table<User, number>("users");
        const count = await users.bulkUpdate([]);

        expect(count).toBe(0);
      });

      it("startsWithAnyOfIgnoreCase with empty array returns empty", async () => {
        const users = db.table<User, number>("users");
        await users.add({ name: "Alice", email: "a@test.com", age: 30 });

        const results = await users.where("name").startsWithAnyOfIgnoreCase([]).toArray();
        expect(results).toHaveLength(0);
      });

      it("anyOfIgnoreCase with empty array returns empty", async () => {
        const users = db.table<User, number>("users");
        await users.add({ name: "Alice", email: "a@test.com", age: 30 });

        const results = await users.where("name").anyOfIgnoreCase([]).toArray();
        expect(results).toHaveLength(0);
      });
    });

    describe("Non-existent data", () => {
      it("get returns undefined for non-existent key", async () => {
        const users = db.table<User, number>("users");
        const result = await users.get(99999);

        expect(result).toBeUndefined();
      });

      it("bulkGet returns undefined for non-existent keys", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

        const results = await users.bulkGet([id, 99999, 99998]);

        expect(results[0]?.name).toBe("Alice");
        expect(results[1]).toBeUndefined();
        expect(results[2]).toBeUndefined();
      });

      it("delete on non-existent key does not throw", async () => {
        const users = db.table<User, number>("users");
        await expect(users.delete(99999)).resolves.not.toThrow();
      });
    });
  });

  describe("Table hooks integration", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();
    });

    describe("creating hook", () => {
      it("fires on add", async () => {
        const users = db.table<User & { createdAt?: number }, number>("users");
        const calls: Array<{ key: number | undefined; item: unknown }> = [];

        users.hook.creating.subscribe((key, obj) => {
          calls.push({ key, item: { ...obj } });
        });

        await users.add({ name: "Alice", email: "a@test.com", age: 30 });

        expect(calls).toHaveLength(1);
        expect(calls[0].item).toMatchObject({ name: "Alice" });
      });

      it("fires on bulkAdd", async () => {
        const users = db.table<User, number>("users");
        const calls: Array<{ key: number | undefined; item: unknown }> = [];

        users.hook.creating.subscribe((key, obj) => {
          calls.push({ key, item: { ...obj } });
        });

        await users.bulkAdd([
          { name: "Alice", email: "a@test.com", age: 30 },
          { name: "Bob", email: "b@test.com", age: 25 },
        ]);

        expect(calls).toHaveLength(2);
      });

      it("fires on upsert when item does not exist", async () => {
        const users = db.table<User, number>("users");
        let createCalled = false;

        users.hook.creating.subscribe(() => {
          createCalled = true;
        });

        await users.upsert({ name: "Alice", email: "a@test.com", age: 30 });

        expect(createCalled).toBe(true);
      });
    });

    describe("updating hook", () => {
      it("fires on update", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });
        const calls: Array<{ changes: unknown; key: number; existing: unknown }> = [];

        users.hook.updating.subscribe((changes, key, existing) => {
          calls.push({ changes, key, existing });
        });

        await users.update(id, { age: 31 });

        expect(calls).toHaveLength(1);
        expect(calls[0].changes).toEqual({ age: 31 });
        expect(calls[0].key).toBe(id);
      });

      it("fires on bulkUpdate", async () => {
        const users = db.table<User, number>("users");
        const [id1, id2] = await users.bulkAdd([
          { name: "Alice", email: "a@test.com", age: 30 },
          { name: "Bob", email: "b@test.com", age: 25 },
        ]);
        const calls: Array<{ changes: unknown; key: number }> = [];

        users.hook.updating.subscribe((changes, key) => {
          calls.push({ changes, key });
        });

        await users.bulkUpdate([
          { key: id1, changes: { age: 31 } },
          { key: id2, changes: { age: 26 } },
        ]);

        expect(calls).toHaveLength(2);
      });

      it("fires on upsert when item exists", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });
        let updateCalled = false;

        users.hook.updating.subscribe(() => {
          updateCalled = true;
        });

        await users.upsert({ id, name: "Alice Updated", email: "a@test.com", age: 31 });

        expect(updateCalled).toBe(true);
      });
    });

    describe("deleting hook", () => {
      it("fires on delete", async () => {
        const users = db.table<User, number>("users");
        const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });
        const calls: Array<{ key: number; existing: unknown }> = [];

        users.hook.deleting.subscribe((key, existing) => {
          calls.push({ key, existing });
        });

        await users.delete(id);

        expect(calls).toHaveLength(1);
        expect(calls[0].key).toBe(id);
        expect(calls[0].existing).toMatchObject({ name: "Alice" });
      });

      it("does not fire on delete for non-existent item", async () => {
        const users = db.table<User, number>("users");
        let deleteCalled = false;

        users.hook.deleting.subscribe(() => {
          deleteCalled = true;
        });

        await users.delete(99999);

        expect(deleteCalled).toBe(false);
      });
    });

    describe("reading hook", () => {
      it("fires on get", async () => {
        const users = db.table<User & { computed?: string }, number>("users");
        const id = await users.add({ name: "Alice", email: "a@test.com", age: 30 });

        users.hook.reading.subscribe((obj) => ({
          ...obj,
          computed: `${obj.name}-computed`,
        }));

        const user = await users.get(id);

        expect(user?.computed).toBe("Alice-computed");
      });

      it("fires on bulkGet", async () => {
        const users = db.table<User & { computed?: string }, number>("users");
        const [id1, id2] = await users.bulkAdd([
          { name: "Alice", email: "a@test.com", age: 30 },
          { name: "Bob", email: "b@test.com", age: 25 },
        ]);

        users.hook.reading.subscribe((obj) => ({
          ...obj,
          computed: `${obj.name}-computed`,
        }));

        const results = await users.bulkGet([id1, id2]);

        expect(results[0]?.computed).toBe("Alice-computed");
        expect(results[1]?.computed).toBe("Bob-computed");
      });
    });
  });

  describe("Empty startsWith", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
      ]);
    });

    it("startsWith empty string matches all", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("name").startsWith("").toArray();

      expect(results).toHaveLength(2);
    });
  });

  describe("keys() alias", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
      ]);
    });

    it("keys() is alias for primaryKeys()", async () => {
      const users = db.table<User, number>("users");
      const keys = await users.toCollection().keys();
      const primaryKeys = await users.toCollection().primaryKeys();

      expect(keys).toEqual(primaryKeys);
    });
  });

  describe("Direct count optimization", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
      ]);
    });

    it("uses fast count path for simple collection", async () => {
      const users = db.table<User, number>("users");
      // This should use the DB count optimization (no filter, no index, no until, no OR)
      const count = await users.toCollection().count();

      expect(count).toBe(3);
    });
  });

  describe("OR query limit edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Dave", email: "d@test.com", age: 40 },
        { name: "Eve", email: "e@test.com", age: 45 },
        { name: "Frank", email: "f@test.com", age: 50 },
      ]);
    });

    it("OR query with limit smaller than merged results", async () => {
      const users = db.table<User, number>("users");
      // Query should match multiple people: age < 30 (Alice) + age > 40 (Eve, Frank)
      // But limit to 2
      const results = await users.where("age").below(30).or("age").above(40).limit(2).toArray();

      expect(results).toHaveLength(2);
    });

    it("OR query on primary key uses getIndexValue path", async () => {
      const users = db.table<User, number>("users");
      // OR on empty string index (primary key)
      const results = await users.where("age").equals(25).or("").above(4).toArray();

      // Alice (age 25) + users with id > 4 (Eve, Frank with ids 5, 6)
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("orderBy index queries", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Charlie", email: "c@test.com", age: 35 },
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
      ]);
    });

    it("orderBy returns items sorted by index", async () => {
      const users = db.table<User, number>("users");
      const results = await users.orderBy("name").toArray();

      expect(results[0].name).toBe("Alice");
      expect(results[1].name).toBe("Bob");
      expect(results[2].name).toBe("Charlie");
    });

    it("orderBy with reverse returns descending order", async () => {
      const users = db.table<User, number>("users");
      const results = await users.orderBy("name").reverse().toArray();

      expect(results[0].name).toBe("Charlie");
      expect(results[1].name).toBe("Bob");
      expect(results[2].name).toBe("Alice");
    });

    it("orderBy with count uses toArray path", async () => {
      const users = db.table<User, number>("users");
      // count() on orderBy collection uses toArray path since ctx.index is set
      const count = await users.orderBy("name").count();

      expect(count).toBe(3);
    });
  });

  describe("Transaction edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();
    });

    it("transaction provides scoped table access", async () => {
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com", age: 30 });

      await db.transaction("r", ["users"], async (tx) => {
        const txUsers = tx.table<User, number>("users");
        const count = await txUsers.count();
        expect(count).toBe(1);
      });
    });
  });

  describe("Non-string types in filters", () => {
    beforeEach(async () => {
      db.version(1).stores({
        items: "++id, value",
      });
      await db.open();
    });

    it("startsWithIgnoreCase returns empty for non-string values", async () => {
      const items = db.table<{ id?: number; value: unknown }, number>("items");
      await items.bulkAdd([
        { value: 123 },
        { value: "hello" },
        { value: null },
        { value: { nested: true } },
      ]);

      const results = await items.where("value").startsWithIgnoreCase("h").toArray();

      expect(results).toHaveLength(1);
      expect(results[0].value).toBe("hello");
    });

    it("equalsIgnoreCase returns empty for non-string values", async () => {
      const items = db.table<{ id?: number; value: unknown }, number>("items");
      await items.bulkAdd([{ value: 123 }, { value: "Hello" }, { value: null }]);

      const results = await items.where("value").equalsIgnoreCase("hello").toArray();

      expect(results).toHaveLength(1);
      expect(results[0].value).toBe("Hello");
    });
  });

  describe("Transaction context edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
        logs: "++id, action",
      });
      await db.open();
    });

    it("transaction context provides mode", async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        expect(tx.mode).toBe("readwrite");
      });

      await db.transaction("r", ["users"], async (tx) => {
        expect(tx.mode).toBe("readonly");
      });
    });

    it("transaction context provides tables list", async () => {
      await db.transaction("r", ["users", "logs"], async (tx) => {
        expect(tx.tables).toContain("users");
        expect(tx.tables).toContain("logs");
      });
    });

    it("transaction context active is true during execution", async () => {
      await db.transaction("r", ["users"], async (tx) => {
        expect(tx.active).toBe(true);
      });
    });

    it("throws InvalidTableError when accessing table not in transaction", async () => {
      await db.transaction("r", ["users"], async (tx) => {
        expect(() => tx.table("logs")).toThrow("not part of this transaction");
      });
    });

    it("abort() stops the transaction", async () => {
      const users = db.table<User, number>("users");
      await users.add({ name: "Initial", email: "i@test.com", age: 20 });

      await expect(
        db.transaction("rw", ["users"], async (tx) => {
          const txUsers = tx.table<User, number>("users");
          await txUsers.add({ name: "Alice", email: "a@test.com", age: 30 });
          tx.abort();
          // After abort, transaction should be inactive
          expect(tx.active).toBe(false);
        }),
      ).rejects.toThrow();

      // Data should not be committed
      const count = await users.count();
      expect(count).toBe(1); // Only Initial
    });
  });

  describe("Schema change errors", () => {
    it("throws when trying to change primary key", async () => {
      // Create v1 database with one primary key
      const db1 = new LessDB(dbName);
      db1.version(1).stores({ users: "++id, name" });
      await db1.open();
      await db1.table("users").add({ name: "Alice" });
      db1.close();

      // Try to change primary key in v2 - should throw
      const db2 = new LessDB(dbName);
      db2.version(1).stores({ users: "++id, name" });
      db2.version(2).stores({ users: "email, name" }); // Changed from ++id to email

      await expect(db2.open()).rejects.toThrow("Cannot change primary key");
    });
  });

  describe("Middleware on open database", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name",
      });
      await db.open();
    });

    it("use() rebuilds core when database is already open", async () => {
      const operations: string[] = [];

      // Add middleware after database is open
      db.use({
        stack: "dbcore",
        name: "post-open-middleware",
        create: (downCore) => {
          operations.push("middleware-created");
          return {};
        },
      });

      // Middleware should have been applied immediately
      expect(operations).toContain("middleware-created");

      // Operations should still work
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "a@test.com", age: 30 });
      const count = await users.count();
      expect(count).toBe(1);
    });

    it("unuse() rebuilds core when database is already open", async () => {
      let middlewareActive = false;

      const middleware: Middleware = {
        stack: "dbcore",
        name: "removable-middleware",
        create: (downCore: DBCore) => {
          middlewareActive = true;
          return {};
        },
      };

      db.use(middleware);
      expect(middlewareActive).toBe(true);

      middlewareActive = false;
      db.unuse(middleware);

      // Core was rebuilt without middleware
      // Add another middleware to verify rebuild happened
      db.use({
        stack: "dbcore",
        name: "verify-middleware",
        create: (downCore) => {
          // If previous middleware was truly removed, this is fresh
          return {};
        },
      });
    });
  });

  describe("WhereClause remaining edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "Bob", email: "b@test.com", age: 30 },
      ]);
    });

    it("startsWithAnyOf with empty array returns empty", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("name").startsWithAnyOf([]).toArray();

      expect(results).toHaveLength(0);
    });

    it("startsWithAnyOfIgnoreCase returns empty on non-string values", async () => {
      // Users have numbers in the age field
      const results = await db
        .table<User, number>("users")
        .where("age")
        .startsWithAnyOfIgnoreCase(["2"])
        .toArray();

      expect(results).toHaveLength(0);
    });

    it("inAnyRange with empty array returns empty", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("age").inAnyRange([]).toArray();

      expect(results).toHaveLength(0);
    });
  });

  describe("compound indexes", () => {
    interface Person {
      id?: number;
      firstName: string;
      lastName: string;
      age: number;
      city: string;
    }

    beforeEach(async () => {
      db.version(1).stores({
        people: "++id, [firstName+lastName], [city+age], &[firstName+lastName+age]",
      });
      await db.open();

      const people = db.table<Person, number>("people");
      await people.bulkAdd([
        { firstName: "John", lastName: "Doe", age: 30, city: "NYC" },
        { firstName: "John", lastName: "Smith", age: 25, city: "LA" },
        { firstName: "Jane", lastName: "Doe", age: 28, city: "NYC" },
        { firstName: "Jane", lastName: "Smith", age: 35, city: "Chicago" },
        { firstName: "Bob", lastName: "Wilson", age: 40, city: "NYC" },
      ]);
    });

    it("creates compound indexes correctly", async () => {
      const people = db.table<Person, number>("people");
      const schema = people.schema;

      // Should have 3 indexes
      expect(schema.indexes).toHaveLength(3);

      // First compound index
      const nameIndex = schema.indexes.find((idx) => idx.name === "firstName+lastName");
      expect(nameIndex).toBeDefined();
      expect(nameIndex?.keyPath).toEqual(["firstName", "lastName"]);

      // Second compound index
      const cityAgeIndex = schema.indexes.find((idx) => idx.name === "city+age");
      expect(cityAgeIndex).toBeDefined();
      expect(cityAgeIndex?.keyPath).toEqual(["city", "age"]);

      // Third compound index (unique)
      const uniqueIndex = schema.indexes.find((idx) => idx.name === "firstName+lastName+age");
      expect(uniqueIndex).toBeDefined();
      expect(uniqueIndex?.keyPath).toEqual(["firstName", "lastName", "age"]);
      expect(uniqueIndex?.unique).toBe(true);
    });

    it("queries compound index with equals", async () => {
      const people = db.table<Person, number>("people");

      // Query for John Doe using compound key
      const results = await people.where("firstName+lastName").equals(["John", "Doe"]).toArray();

      expect(results).toHaveLength(1);
      expect(results[0].firstName).toBe("John");
      expect(results[0].lastName).toBe("Doe");
    });

    it("queries compound index with between", async () => {
      const people = db.table<Person, number>("people");

      // Query for people in NYC with age between 25 and 35
      const results = await people.where("city+age").between(["NYC", 25], ["NYC", 35]).toArray();

      expect(results).toHaveLength(2);
      expect(results.every((p) => p.city === "NYC")).toBe(true);
    });

    it("queries compound index with above", async () => {
      const people = db.table<Person, number>("people");

      // Query for compound keys above ["Jane", "Doe"]
      const results = await people.where("firstName+lastName").above(["Jane", "Doe"]).toArray();

      // Should include Jane Smith, John Doe, John Smith (alphabetically after Jane Doe)
      expect(results.length).toBeGreaterThan(0);
    });

    it("queries compound index with anyOf", async () => {
      const people = db.table<Person, number>("people");

      const results = await people
        .where("firstName+lastName")
        .anyOf([
          ["John", "Doe"],
          ["Jane", "Doe"],
        ])
        .toArray();

      expect(results).toHaveLength(2);
      expect(results.some((p) => p.firstName === "John" && p.lastName === "Doe")).toBe(true);
      expect(results.some((p) => p.firstName === "Jane" && p.lastName === "Doe")).toBe(true);
    });

    it("uses compound index for filter operations", async () => {
      const people = db.table<Person, number>("people");

      // Filter with noneOf on compound index
      const results = await people
        .where("firstName+lastName")
        .noneOf([
          ["John", "Doe"],
          ["John", "Smith"],
        ])
        .toArray();

      expect(results).toHaveLength(3);
      expect(results.every((p) => p.firstName !== "John")).toBe(true);
    });

    it("enforces uniqueness on unique compound index", async () => {
      const people = db.table<Person, number>("people");

      // Try to add a duplicate based on [firstName+lastName+age]
      await expect(
        people.add({ firstName: "John", lastName: "Doe", age: 30, city: "Boston" }),
      ).rejects.toThrow();
    });

    it("allows same partial compound key with different third field", async () => {
      const people = db.table<Person, number>("people");

      // Same firstName+lastName but different age should work
      const id = await people.add({
        firstName: "John",
        lastName: "Doe",
        age: 31,
        city: "Boston",
      });

      expect(id).toBeDefined();

      const all = await people.toArray();
      expect(all).toHaveLength(6);
    });

    it("works with or queries on compound indexes", async () => {
      const people = db.table<Person, number>("people");

      const results = await people
        .where("firstName+lastName")
        .equals(["John", "Doe"])
        .or("city+age")
        .equals(["Chicago", 35])
        .toArray();

      expect(results).toHaveLength(2);
    });

    it("sorts correctly by compound index", async () => {
      const people = db.table<Person, number>("people");

      const results = await people.orderBy("firstName+lastName").toArray();

      // Should be sorted by firstName, then lastName
      expect(results[0].firstName).toBe("Bob");
      expect(results[1].firstName).toBe("Jane");
      expect(results[1].lastName).toBe("Doe");
      expect(results[2].firstName).toBe("Jane");
      expect(results[2].lastName).toBe("Smith");
    });

    it("extracts compound key values correctly for filtering", async () => {
      const people = db.table<Person, number>("people");

      // Use notEqual which internally extracts the compound key
      const results = await people.where("firstName+lastName").notEqual(["John", "Doe"]).toArray();

      expect(results).toHaveLength(4);
      expect(results.every((p) => !(p.firstName === "John" && p.lastName === "Doe"))).toBe(true);
    });

    it("handles OrClause anyOf with compound keys", async () => {
      const people = db.table<Person, number>("people");

      // Test that anyOf works with compound keys in OR queries
      const results = await people
        .where("city+age")
        .equals(["NYC", 30])
        .or("firstName+lastName")
        .anyOf([
          ["Jane", "Doe"],
          ["Bob", "Wilson"],
        ])
        .toArray();

      expect(results).toHaveLength(3);
      expect(results.some((p) => p.firstName === "Jane" && p.lastName === "Doe")).toBe(true);
      expect(results.some((p) => p.firstName === "Bob" && p.lastName === "Wilson")).toBe(true);
      expect(results.some((p) => p.firstName === "John" && p.lastName === "Doe")).toBe(true);
    });

    it("handles OrClause noneOf with compound keys", async () => {
      const people = db.table<Person, number>("people");

      // Test that noneOf works with compound keys in OR queries
      const results = await people
        .where("city+age")
        .equals(["NYC", 30])
        .or("firstName+lastName")
        .noneOf([
          ["John", "Smith"],
          ["Bob", "Wilson"],
        ])
        .toArray();

      // Should include John Doe + everyone except John Smith and Bob Wilson
      expect(results).toHaveLength(3);
      expect(results.some((p) => p.firstName === "John" && p.lastName === "Doe")).toBe(true);
      expect(results.some((p) => p.firstName === "Jane" && p.lastName === "Doe")).toBe(true);
    });
  });

  describe("case-insensitive edge cases", () => {
    beforeEach(async () => {
      db.version(1).stores({
        users: "++id, name, age",
      });
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "a@test.com", age: 25 },
        { name: "", email: "empty@test.com", age: 30 },
        { name: "Bob", email: "b@test.com", age: 35 },
      ]);
    });

    it("handles equalsIgnoreCase with empty string", async () => {
      const users = db.table<User, number>("users");
      const results = await users.where("name").equalsIgnoreCase("").toArray();

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("");
    });

    it("handles anyOfIgnoreCase with empty strings", async () => {
      const users = db.table<User, number>("users");

      // Array with only empty string
      const results1 = await users.where("name").anyOfIgnoreCase([""]).toArray();
      expect(results1).toHaveLength(1);
      expect(results1[0].name).toBe("");

      // Mixed empty and non-empty
      const results2 = await users.where("name").anyOfIgnoreCase(["", "ALICE"]).toArray();
      expect(results2).toHaveLength(2);
      expect(results2.some((u) => u.name === "")).toBe(true);
      expect(results2.some((u) => u.name === "Alice")).toBe(true);
    });
  });

  describe("Case-insensitive cursor jumping algorithm", () => {
    interface Item {
      id?: number;
      name: string;
    }

    beforeEach(async () => {
      db.version(1).stores({
        items: "++id, name",
      });
      await db.open();
    });

    describe("equalsIgnoreCase edge cases", () => {
      it("finds all case variations of a word", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
          { name: "HeLLo" },
          { name: "hELLO" },
          { name: "world" }, // non-match
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(5);
        expect(results.every((r) => r.name.toLowerCase() === "hello")).toBe(true);
      });

      it("handles single character strings", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "a" },
          { name: "A" },
          { name: "b" },
          { name: "B" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("a").toArray();

        expect(results).toHaveLength(2);
        expect(results.map((r) => r.name).sort()).toEqual(["A", "a"]);
      });

      it("handles strings at index boundaries", async () => {
        const items = db.table<Item, number>("items");
        // Add strings that sort at beginning and end of range
        await items.bulkAdd([
          { name: "AAA" }, // beginning of uppercase range
          { name: "aaa" }, // end of lowercase range
          { name: "Aaa" }, // mixed
          { name: "aaA" }, // mixed
          { name: "ZZZ" }, // outside range
        ]);

        const results = await items.where("name").equalsIgnoreCase("aaa").toArray();

        expect(results).toHaveLength(4);
        expect(results.every((r) => r.name.toLowerCase() === "aaa")).toBe(true);
      });

      it("returns empty array when no matches exist", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "apple" },
          { name: "banana" },
          { name: "cherry" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("orange").toArray();

        expect(results).toHaveLength(0);
      });

      it("handles strings with numbers", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "user1" },
          { name: "USER1" },
          { name: "User1" },
          { name: "user2" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("user1").toArray();

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.name.toLowerCase() === "user1")).toBe(true);
      });

      it("handles strings with special characters", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello-world" },
          { name: "HELLO-WORLD" },
          { name: "Hello-World" },
          { name: "hello_world" }, // different separator
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello-world").toArray();

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.name.toLowerCase() === "hello-world")).toBe(true);
      });

      it("handles strings with spaces", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello world" },
          { name: "HELLO WORLD" },
          { name: "Hello World" },
          { name: "helloworld" }, // no space
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello world").toArray();

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.name.toLowerCase() === "hello world")).toBe(true);
      });

      it("handles very long strings", async () => {
        const items = db.table<Item, number>("items");
        const longString = "a".repeat(100);
        await items.bulkAdd([
          { name: longString },
          { name: longString.toUpperCase() },
          { name: longString.slice(0, 50) + longString.slice(50).toUpperCase() },
        ]);

        const results = await items.where("name").equalsIgnoreCase(longString).toArray();

        expect(results).toHaveLength(3);
      });

      it("correctly skips non-matching entries in the range", async () => {
        const items = db.table<Item, number>("items");
        // Add many items that fall within the key range but don't match
        const nonMatching = [];
        for (let i = 0; i < 100; i++) {
          nonMatching.push({ name: `Hfoo${i}` }); // starts with H but doesn't match "hello"
          nonMatching.push({ name: `hbar${i}` }); // starts with h but doesn't match "hello"
        }
        await items.bulkAdd([
          ...nonMatching,
          { name: "hello" },
          { name: "HELLO" },
          { name: "HeLLo" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.name.toLowerCase() === "hello")).toBe(true);
      });

      it("works with limit", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
          { name: "HeLLo" },
          { name: "hELLO" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").limit(2).toArray();

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.name.toLowerCase() === "hello")).toBe(true);
      });

      it("works with offset", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
        ]);

        const allResults = await items.where("name").equalsIgnoreCase("hello").toArray();
        const offsetResults = await items
          .where("name")
          .equalsIgnoreCase("hello")
          .offset(1)
          .toArray();

        expect(offsetResults).toHaveLength(allResults.length - 1);
      });

      it("works with count", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
          { name: "world" },
        ]);

        const count = await items.where("name").equalsIgnoreCase("hello").count();

        expect(count).toBe(3);
      });

      it("works with first", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
        ]);

        const first = await items.where("name").equalsIgnoreCase("hello").first();

        expect(first).toBeDefined();
        expect(first!.name.toLowerCase()).toBe("hello");
      });

      it("works with primaryKeys", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
          { name: "world" },
        ]);

        const keys = await items.where("name").equalsIgnoreCase("hello").primaryKeys();

        expect(keys).toHaveLength(3);
      });
    });

    describe("startsWithIgnoreCase edge cases", () => {
      it("finds all case variations of prefix", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello World" },
          { name: "HELLO there" },
          { name: "HeLLo123" },
          { name: "world" }, // non-match
        ]);

        const results = await items.where("name").startsWithIgnoreCase("hello").toArray();

        expect(results).toHaveLength(4);
        expect(results.every((r) => r.name.toLowerCase().startsWith("hello"))).toBe(true);
      });

      it("handles single character prefix", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "apple" },
          { name: "Ant" },
          { name: "AMAZING" },
          { name: "banana" },
        ]);

        const results = await items.where("name").startsWithIgnoreCase("a").toArray();

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.name.toLowerCase().startsWith("a"))).toBe(true);
      });

      it("handles prefix that matches entire string", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "test" },
          { name: "TEST" },
          { name: "Test" },
          { name: "testing" }, // longer
        ]);

        const results = await items.where("name").startsWithIgnoreCase("test").toArray();

        expect(results).toHaveLength(4);
      });

      it("handles prefix longer than some strings", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hi" }, // shorter than prefix
          { name: "hello" },
          { name: "HELLO WORLD" },
        ]);

        const results = await items.where("name").startsWithIgnoreCase("hello").toArray();

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.name.toLowerCase().startsWith("hello"))).toBe(true);
      });

      it("correctly skips non-matching entries", async () => {
        const items = db.table<Item, number>("items");
        // Add items that start with same letter but different prefix
        await items.bulkAdd([
          { name: "Habc" },
          { name: "Hdef" },
          { name: "Hello" },
          { name: "HELLO WORLD" },
          { name: "Hxyz" },
          { name: "hzzz" },
        ]);

        const results = await items.where("name").startsWithIgnoreCase("hello").toArray();

        expect(results).toHaveLength(2);
      });

      it("works with limit", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello1" },
          { name: "Hello2" },
          { name: "HELLO3" },
        ]);

        const results = await items.where("name").startsWithIgnoreCase("hello").limit(2).toArray();

        expect(results).toHaveLength(2);
      });
    });

    describe("anyOfIgnoreCase edge cases", () => {
      it("finds all case variations of multiple values", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "alice" },
          { name: "ALICE" },
          { name: "bob" },
          { name: "BOB" },
          { name: "charlie" }, // non-match
        ]);

        const results = await items.where("name").anyOfIgnoreCase(["alice", "bob"]).toArray();

        expect(results).toHaveLength(4);
      });

      it("handles single value (should use equalsIgnoreCase path)", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "test" },
          { name: "TEST" },
          { name: "Test" },
        ]);

        const results = await items.where("name").anyOfIgnoreCase(["test"]).toArray();

        expect(results).toHaveLength(3);
      });

      it("handles values with different lengths", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "a" },
          { name: "A" },
          { name: "abc" },
          { name: "ABC" },
          { name: "abcdef" },
          { name: "ABCDEF" },
        ]);

        const results = await items.where("name").anyOfIgnoreCase(["a", "abc", "abcdef"]).toArray();

        expect(results).toHaveLength(6);
      });

      it("handles overlapping value ranges", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "apple" },
          { name: "APPLE" },
          { name: "apricot" },
          { name: "APRICOT" },
          { name: "avocado" },
        ]);

        const results = await items
          .where("name")
          .anyOfIgnoreCase(["apple", "apricot"])
          .toArray();

        expect(results).toHaveLength(4);
      });

      it("returns empty for no matches", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "apple" },
          { name: "banana" },
        ]);

        const results = await items.where("name").anyOfIgnoreCase(["cherry", "date"]).toArray();

        expect(results).toHaveLength(0);
      });

      it("works with many values", async () => {
        const items = db.table<Item, number>("items");
        const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
        await items.bulkAdd(
          names.flatMap((n) => [{ name: n }, { name: n.toUpperCase() }, { name: n[0]!.toUpperCase() + n.slice(1) }]),
        );

        const results = await items.where("name").anyOfIgnoreCase(names).toArray();

        expect(results).toHaveLength(15); // 5 names x 3 variations each
      });
    });

    describe("cursor algorithm with filter chaining", () => {
      it("equalsIgnoreCase with additional filter", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
        ]);

        // The cursor algorithm should work, then filter is applied post-hoc
        const results = await items
          .where("name")
          .equalsIgnoreCase("hello")
          .filter((item) => item.name === item.name.toUpperCase())
          .toArray();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("HELLO");
      });

      it("startsWithIgnoreCase with additional filter", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello world" },
          { name: "Hello There" },
          { name: "HELLO UNIVERSE" },
        ]);

        const results = await items
          .where("name")
          .startsWithIgnoreCase("hello")
          .filter((item) => item.name.includes("world"))
          .toArray();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("hello world");
      });
    });

    describe("cursor algorithm with modify and delete", () => {
      it("equalsIgnoreCase with modify", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
          { name: "world" },
        ]);

        const count = await items.where("name").equalsIgnoreCase("hello").modify({ name: "updated" });

        expect(count).toBe(3);

        const all = await items.toArray();
        expect(all.filter((i) => i.name === "updated")).toHaveLength(3);
        expect(all.filter((i) => i.name === "world")).toHaveLength(1);
      });

      it("equalsIgnoreCase with delete", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "Hello" },
          { name: "HELLO" },
          { name: "world" },
        ]);

        const count = await items.where("name").equalsIgnoreCase("hello").delete();

        expect(count).toBe(3);

        const remaining = await items.toArray();
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!.name).toBe("world");
      });
    });

    describe("cursor algorithm stress tests", () => {
      it("handles large dataset with sparse matches", async () => {
        const items = db.table<Item, number>("items");

        // Create 1000 items with only 3 matching "target"
        const data: Item[] = [];
        for (let i = 0; i < 500; i++) {
          data.push({ name: `item${i}` });
        }
        data.push({ name: "target" });
        data.push({ name: "TARGET" });
        data.push({ name: "Target" });
        for (let i = 500; i < 1000; i++) {
          data.push({ name: `item${i}` });
        }

        await items.bulkAdd(data);

        const results = await items.where("name").equalsIgnoreCase("target").toArray();

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.name.toLowerCase() === "target")).toBe(true);
      });

      it("handles large dataset with many matches", async () => {
        const items = db.table<Item, number>("items");

        // Create items with many case variations
        const data: Item[] = [];
        const word = "test";
        // Generate all 16 case combinations of "test"
        for (let mask = 0; mask < 16; mask++) {
          let variation = "";
          for (let i = 0; i < 4; i++) {
            const char = word[i]!;
            variation += mask & (1 << i) ? char.toUpperCase() : char;
          }
          data.push({ name: variation });
        }
        // Add some non-matching items
        for (let i = 0; i < 100; i++) {
          data.push({ name: `other${i}` });
        }

        await items.bulkAdd(data);

        const results = await items.where("name").equalsIgnoreCase("test").toArray();

        expect(results).toHaveLength(16);
      });
    });

    describe("cursor algorithm boundary conditions", () => {
      it("handles string that is exactly the lower bound (uppercase)", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "HELLO" }, // exactly the lower bound
          { name: "hello" },
          { name: "Hello" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(3);
        expect(results.some((r) => r.name === "HELLO")).toBe(true);
      });

      it("handles string that is exactly the upper bound (lowercase)", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "HELLO" },
          { name: "hello" }, // exactly the upper bound
          { name: "Hello" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(3);
        expect(results.some((r) => r.name === "hello")).toBe(true);
      });

      it("handles only uppercase match", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "HELLO" },
          { name: "world" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("HELLO");
      });

      it("handles only lowercase match", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "hello" },
          { name: "WORLD" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("hello");
      });

      it("handles alternating case pattern", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "HeLLo" },
          { name: "hElLo" },
          { name: "hELLo" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(3);
      });

      it("handles adjacent non-matching strings", async () => {
        const items = db.table<Item, number>("items");
        // Strings that are close in sort order but don't match
        await items.bulkAdd([
          { name: "HELLM" }, // before HELLO
          { name: "HELLN" }, // before HELLO
          { name: "HELLO" }, // match
          { name: "HELLP" }, // after HELLO
          { name: "HELLQ" }, // after HELLO
          { name: "hello" }, // match
          { name: "hellp" }, // after hello
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.name.toLowerCase() === "hello")).toBe(true);
      });

      it("handles strings with same prefix but different length", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "HELL" }, // shorter
          { name: "HELLO" }, // match
          { name: "HELLOWORLD" }, // longer
          { name: "hello" }, // match
          { name: "helloworld" }, // longer
        ]);

        const results = await items.where("name").equalsIgnoreCase("hello").toArray();

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.name.toLowerCase() === "hello")).toBe(true);
      });

      it("handles repeated characters with case variations", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "aaa" },
          { name: "AAA" },
          { name: "AaA" },
          { name: "aAa" },
          { name: "aaA" },
          { name: "Aaa" },
          { name: "AAa" },
          { name: "aAA" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("aaa").toArray();

        expect(results).toHaveLength(8);
      });

      it("handles unicode letters with case", async () => {
        const items = db.table<Item, number>("items");
        // Note: JavaScript's toUpperCase/toLowerCase handle some unicode
        await items.bulkAdd([
          { name: "café" },
          { name: "CAFÉ" },
          { name: "Café" },
        ]);

        const results = await items.where("name").equalsIgnoreCase("café").toArray();

        expect(results).toHaveLength(3);
      });
    });

    describe("startsWithIgnoreCase boundary conditions", () => {
      it("finds prefix at lower bound", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "HELLO world" },
          { name: "Hello there" },
          { name: "hello you" },
        ]);

        const results = await items.where("name").startsWithIgnoreCase("hello").toArray();

        expect(results).toHaveLength(3);
      });

      it("correctly excludes similar but non-matching prefixes", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "HELP me" }, // different word
          { name: "HELLO world" }, // match
          { name: "HELM of ship" }, // different word
        ]);

        const results = await items.where("name").startsWithIgnoreCase("hello").toArray();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("HELLO world");
      });

      it("handles prefix that spans the entire string", async () => {
        const items = db.table<Item, number>("items");
        await items.bulkAdd([
          { name: "cat" },
          { name: "CAT" },
          { name: "Cat" },
          { name: "category" }, // longer
        ]);

        const results = await items.where("name").startsWithIgnoreCase("cat").toArray();

        expect(results).toHaveLength(4);
      });
    });
  });
});
