/**
 * Tests for table hooks - lifecycle events for CRUD operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LessDB } from "../src/index.js";
import { useTestDB, generateDbName, cleanupDB } from "./helpers/setup.js";

interface User {
  id?: number;
  name: string;
  email: string;
}

describe("hooks", () => {
  const { setup, teardown, getDB } = useTestDB({ users: "++id, name, &email" });
  let db: LessDB;

  beforeEach(() => {
    db = setup();
  });

  afterEach(async () => {
    await teardown();
  });

  describe("creating hook", () => {
    it("fires before adding an item", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      users.hook.creating.subscribe(handler);
      await users.add({ name: "Alice", email: "alice@test.com" });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(undefined, { name: "Alice", email: "alice@test.com" });
    });

    it("fires for each item in bulkAdd", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      users.hook.creating.subscribe(handler);
      await users.bulkAdd([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("receives the key when explicitly provided (outbound key)", async () => {
      // Test with outbound key table (++ without keyPath)
      const db2 = new LessDB(generateDbName("outbound-key-test"));
      db2.version(1).stores({ items: "++" }); // Outbound auto-increment
      await db2.open();

      const items = db2.table<{ name: string }, number>("items");
      const handler = vi.fn();

      items.hook.creating.subscribe(handler);
      await items.add({ name: "test" }, 42); // Explicitly provide key

      expect(handler).toHaveBeenCalledWith(42, { name: "test" });
      await cleanupDB(db2);
    });

    it("receives undefined key for inbound key tables", async () => {
      // For inbound key tables, the key is extracted from the object, not passed separately
      const db2 = new LessDB(generateDbName("inbound-key-test"));
      db2.version(1).stores({ settings: "key" }); // Inbound key on "key" property
      await db2.open();

      const settings = db2.table<{ key: string; value: string }, string>("settings");
      const handler = vi.fn();

      settings.hook.creating.subscribe(handler);
      await settings.add({ key: "theme", value: "dark" });

      // Key is undefined because it's extracted from the object internally
      expect(handler).toHaveBeenCalledWith(undefined, { key: "theme", value: "dark" });
      await cleanupDB(db2);
    });
  });

  describe("reading hook", () => {
    it("transforms items on get", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      users.hook.reading.subscribe((obj) => ({
        ...obj,
        name: obj.name.toUpperCase(),
      }));

      const id = await users.add({ name: "Alice", email: "alice@test.com" });
      const user = await users.get(id);

      expect(user?.name).toBe("ALICE");
    });

    it("transforms items in bulkGet", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      users.hook.reading.subscribe((obj) => ({
        ...obj,
        name: obj.name.toUpperCase(),
      }));

      const ids = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);
      const results = await users.bulkGet(ids);

      expect(results[0]?.name).toBe("ALICE");
      expect(results[1]?.name).toBe("BOB");
    });

    it("last transformer wins", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      users.hook.reading.subscribe((obj) => ({ ...obj, name: "first" }));
      users.hook.reading.subscribe((obj) => ({ ...obj, name: "second" }));

      const id = await users.add({ name: "Alice", email: "alice@test.com" });
      const user = await users.get(id);

      expect(user?.name).toBe("second");
    });

    it("transforms items in toArray", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      users.hook.reading.subscribe((obj) => ({
        ...obj,
        name: obj.name.toUpperCase(),
      }));

      await users.bulkAdd([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);
      const results = await users.toArray();

      expect(results[0]?.name).toBe("ALICE");
      expect(results[1]?.name).toBe("BOB");
    });

    it("raw() bypasses reading hooks", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      users.hook.reading.subscribe((obj) => ({
        ...obj,
        name: obj.name.toUpperCase(),
      }));

      await users.bulkAdd([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);

      // Without raw(), hooks are applied
      const transformed = await users.toCollection().toArray();
      expect(transformed[0]?.name).toBe("ALICE");

      // With raw(), hooks are bypassed
      const raw = await users.toCollection().raw().toArray();
      expect(raw[0]?.name).toBe("Alice");
    });
  });

  describe("updating hook", () => {
    it("fires before update", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      users.hook.updating.subscribe(handler);

      const id = await users.add({ name: "Alice", email: "alice@test.com" });
      await users.update(id, { name: "Alice Updated" });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        { name: "Alice Updated" },
        id,
        expect.objectContaining({ name: "Alice", email: "alice@test.com" }),
      );
    });

    it("fires before upsert on existing item", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      users.hook.updating.subscribe(handler);

      const id = await users.add({ name: "Alice", email: "alice@test.com" });
      await users.upsert({ id, name: "Alice Updated", email: "alice@test.com" });

      expect(handler).toHaveBeenCalledOnce();
    });

    it("fires for each item in bulkUpdate", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      users.hook.updating.subscribe(handler);

      const ids = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);
      await users.bulkUpdate([
        { key: ids[0]!, changes: { name: "Alice Updated" } },
        { key: ids[1]!, changes: { name: "Bob Updated" } },
      ]);

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("deleting hook", () => {
    it("fires before delete", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      users.hook.deleting.subscribe(handler);

      const id = await users.add({ name: "Alice", email: "alice@test.com" });
      await users.delete(id);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ name: "Alice", email: "alice@test.com" }),
      );
    });

    it("does not fire when item does not exist", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      users.hook.deleting.subscribe(handler);
      await users.delete(9999);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribe", () => {
    it("stops hook from being called after unsubscribe", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const handler = vi.fn();

      const unsub = users.hook.creating.subscribe(handler);
      await users.add({ name: "Alice", email: "alice@test.com" });

      unsub();
      await users.add({ name: "Bob", email: "bob@test.com" });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("multiple subscribers", () => {
    it("calls subscribers in order of registration", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const order: number[] = [];

      users.hook.creating.subscribe(() => order.push(1));
      users.hook.creating.subscribe(() => order.push(2));
      users.hook.creating.subscribe(() => order.push(3));

      await users.add({ name: "Alice", email: "alice@test.com" });

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("hasHandlers optimization", () => {
    it("skips hook processing when no handlers registered", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      // This tests the optimization - hooks should not affect performance when not used
      expect(users.hook.creating.hasHandlers()).toBe(false);
      expect(users.hook.reading.hasHandlers()).toBe(false);
      expect(users.hook.updating.hasHandlers()).toBe(false);
      expect(users.hook.deleting.hasHandlers()).toBe(false);

      users.hook.creating.subscribe(() => {});
      expect(users.hook.creating.hasHandlers()).toBe(true);
    });
  });

  describe("error propagation", () => {
    it("propagates errors from creating hook", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      users.hook.creating.subscribe(() => {
        throw new Error("Creating hook error");
      });

      await expect(users.add({ name: "Alice", email: "alice@test.com" })).rejects.toThrow(
        "Creating hook error",
      );
    });

    it("propagates errors from reading hook", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      const id = await users.add({ name: "Alice", email: "alice@test.com" });

      users.hook.reading.subscribe(() => {
        throw new Error("Reading hook error");
      });

      await expect(users.get(id)).rejects.toThrow("Reading hook error");
    });

    it("propagates errors from updating hook", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      const id = await users.add({ name: "Alice", email: "alice@test.com" });

      users.hook.updating.subscribe(() => {
        throw new Error("Updating hook error");
      });

      await expect(users.update(id, { name: "Bob" })).rejects.toThrow("Updating hook error");
    });

    it("propagates errors from deleting hook", async () => {
      await db.open();
      const users = db.table<User, number>("users");

      const id = await users.add({ name: "Alice", email: "alice@test.com" });

      users.hook.deleting.subscribe(() => {
        throw new Error("Deleting hook error");
      });

      await expect(users.delete(id)).rejects.toThrow("Deleting hook error");
    });

    it("stops subsequent handlers when a handler throws", async () => {
      await db.open();
      const users = db.table<User, number>("users");
      const secondHandler = vi.fn();

      users.hook.creating.subscribe(() => {
        throw new Error("First handler error");
      });
      users.hook.creating.subscribe(secondHandler);

      await expect(users.add({ name: "Alice", email: "alice@test.com" })).rejects.toThrow(
        "First handler error",
      );

      // Second handler should not have been called
      expect(secondHandler).not.toHaveBeenCalled();
    });
  });
});
