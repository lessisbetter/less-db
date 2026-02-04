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
} from "./index.js";

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
        name: "test-middleware",
        level: 1,
        create: (downCore: DBCore): DBCore => {
          middlewareCalled = true;
          return downCore;
        },
      };

      db.use(middleware);
      await db.open();

      expect(middlewareCalled).toBe(true);
    });

    it("allows middleware to wrap operations", async () => {
      const operations: string[] = [];

      const middleware: Middleware = {
        name: "logging-middleware",
        create: (downCore: DBCore): DBCore => {
          const wrappedTables = new Map<string, DBCoreTable>();

          return {
            tables: downCore.tables,
            transaction: (tables, mode) => downCore.transaction(tables, mode),
            table: (name: string): DBCoreTable => {
              if (!wrappedTables.has(name)) {
                const downTable = downCore.table(name);
                wrappedTables.set(name, {
                  ...downTable,
                  get: async (trans: DBCoreTransaction, key: unknown) => {
                    operations.push(`get:${name}:${key}`);
                    return downTable.get(trans, key);
                  },
                  mutate: async (trans: DBCoreTransaction, req: DBCoreMutateRequest) => {
                    operations.push(`mutate:${name}:${req.type}`);
                    return downTable.mutate(trans, req);
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
        name: "test-middleware",
        create: (downCore: DBCore): DBCore => {
          middlewareCalled = true;
          return downCore;
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
        name: "high-level",
        level: 10,
        create: (downCore: DBCore): DBCore => {
          order.push("high");
          return downCore;
        },
      };

      const lowLevel: Middleware = {
        name: "low-level",
        level: 1,
        create: (downCore: DBCore): DBCore => {
          order.push("low");
          return downCore;
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
});
