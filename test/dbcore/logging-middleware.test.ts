/**
 * Tests for the logging middleware.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LessDB } from "../../src/less-db.js";
import {
  createLoggingMiddleware,
  type LogEntry,
  type LogHandler,
} from "../../src/dbcore/logging-middleware.js";

interface User {
  id?: number;
  name: string;
  email: string;
}

describe("logging middleware", () => {
  let db: LessDB;
  let dbName: string;
  let logs: LogEntry[];
  let handler: LogHandler;

  beforeEach(() => {
    dbName = `test-logging-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logs = [];
    handler = (entry) => logs.push(entry);
  });

  afterEach(async () => {
    if (db) {
      db.close();
      await db.delete();
    }
  });

  describe("basic logging", () => {
    it("logs get operations", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "alice@test.com" });
      await users.get(id);

      const getLog = logs.find((l) => l.operation === "get");
      expect(getLog).toBeDefined();
      expect(getLog?.table).toBe("users");
      expect(getLog?.level).toMatch(/debug|info/);
      expect(getLog?.durationMs).toBeGreaterThanOrEqual(0);
      expect(getLog?.transactionId).toBeDefined();
    });

    it("logs getMany operations", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const users = db.table<User, number>("users");
      const ids = await users.bulkAdd([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);
      await users.bulkGet(ids);

      const getManyLog = logs.find((l) => l.operation === "getMany");
      expect(getManyLog).toBeDefined();
      expect(getManyLog?.table).toBe("users");
    });

    it("logs query operations", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });
      await users.toArray();

      const queryLog = logs.find((l) => l.operation === "query");
      expect(queryLog).toBeDefined();
      expect(queryLog?.table).toBe("users");
    });

    it("logs mutate operations", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });

      const mutateLog = logs.find((l) => l.operation === "mutate");
      expect(mutateLog).toBeDefined();
      expect(mutateLog?.table).toBe("users");
    });

    it("logs count operations", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });
      await users.count();

      const countLog = logs.find((l) => l.operation === "count");
      expect(countLog).toBeDefined();
      expect(countLog?.table).toBe("users");
    });
  });

  describe("log levels", () => {
    it("respects minimum log level", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "warn" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });
      await users.get(1);

      // At warn level, only slow operations or errors should be logged
      // Normal operations should not appear
      expect(logs.every((l) => l.level === "warn" || l.level === "error")).toBe(true);
    });

    it("logs errors at error level", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, &email" });
      db.use(createLoggingMiddleware({ handler, level: "error" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });

      // Try to add duplicate email
      try {
        await users.add({ name: "Bob", email: "alice@test.com" });
      } catch {
        // Expected
      }

      const errorLog = logs.find((l) => l.level === "error");
      expect(errorLog).toBeDefined();
      expect(errorLog?.error).toBeDefined();
    });
  });

  describe("slow operation detection", () => {
    it("logs slow operations at warn level", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(
        createLoggingMiddleware({
          handler,
          level: "info",
          slowThresholdMs: 0, // Any operation is "slow"
        }),
      );
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });

      const warnLog = logs.find((l) => l.level === "warn");
      expect(warnLog).toBeDefined();
    });
  });

  describe("transaction tracking", () => {
    it("includes transaction ID in logs", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]?.transactionId).toBeDefined();
      expect(logs[0]?.transactionId.length).toBeGreaterThan(0);
    });

    it("uses consistent transaction ID within a transaction", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      await db.transaction("rw", ["users"], async (tx) => {
        const users = tx.table<User, number>("users");
        await users.add({ name: "Alice", email: "alice@test.com" });
        await users.add({ name: "Bob", email: "bob@test.com" });
        await users.get(1);
      });

      // All operations in the transaction should have the same transaction ID
      expect(logs.length).toBeGreaterThan(0);
      const txIds = new Set(logs.map((l) => l.transactionId));
      expect(txIds.size).toBe(1); // Exactly one transaction ID
    });
  });

  describe("operation details", () => {
    it("includes details when enabled", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(
        createLoggingMiddleware({
          handler,
          level: "debug",
          includeDetails: true,
        }),
      );
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });
      await users.get(1);

      const getLog = logs.find((l) => l.operation === "get");
      expect(getLog?.details).toBeDefined();
      expect(getLog?.details?.key).toBe(1);
    });

    it("excludes details when disabled", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(
        createLoggingMiddleware({
          handler,
          level: "debug",
          includeDetails: false,
        }),
      );
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });
      await users.get(1);

      const getLog = logs.find((l) => l.operation === "get");
      expect(getLog?.details).toBeUndefined();
    });

    it("includes mutate type in details", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(
        createLoggingMiddleware({
          handler,
          level: "debug",
          includeDetails: true,
        }),
      );
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "alice@test.com" });

      const addLog = logs.find((l) => l.operation === "mutate" && l.details?.type === "add");
      expect(addLog).toBeDefined();
      expect(addLog?.details?.valueCount).toBe(1);

      await users.delete(id);

      const deleteLog = logs.find((l) => l.operation === "mutate" && l.details?.type === "delete");
      expect(deleteLog).toBeDefined();
      expect(deleteLog?.details?.keyCount).toBe(1);
    });

    it("logs put operations", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(
        createLoggingMiddleware({
          handler,
          level: "debug",
          includeDetails: true,
        }),
      );
      await db.open();

      const users = db.table<User, number>("users");
      const id = await users.add({ name: "Alice", email: "alice@test.com" });
      await users.put({ id, name: "Alice Updated", email: "alice@test.com" });

      const putLog = logs.find((l) => l.operation === "mutate" && l.details?.type === "put");
      expect(putLog).toBeDefined();
      expect(putLog?.details?.valueCount).toBe(1);
    });

    it("logs deleteRange operations", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(
        createLoggingMiddleware({
          handler,
          level: "debug",
          includeDetails: true,
        }),
      );
      await db.open();

      const users = db.table<User, number>("users");
      await users.bulkAdd([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);

      // clear() uses deleteRange internally
      await users.clear();

      const deleteRangeLog = logs.find(
        (l) => l.operation === "mutate" && l.details?.type === "deleteRange",
      );
      expect(deleteRangeLog).toBeDefined();
    });
  });

  describe("timestamp and duration", () => {
    it("includes timestamp in logs", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const beforeTime = new Date();
      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });
      const afterTime = new Date();

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]?.timestamp).toBeInstanceOf(Date);
      expect(logs[0]?.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(logs[0]?.timestamp.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it("tracks operation duration", async () => {
      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ handler, level: "debug" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });

      expect(logs.length).toBeGreaterThan(0);
      expect(typeof logs[0]?.durationMs).toBe("number");
      expect(logs[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("default handler", () => {
    it("uses console by default", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      db = new LessDB(dbName);
      db.version(1).stores({ users: "++id, name" });
      db.use(createLoggingMiddleware({ level: "info" }));
      await db.open();

      const users = db.table<User, number>("users");
      await users.add({ name: "Alice", email: "alice@test.com" });

      expect(consoleSpy).toHaveBeenCalled();
      const callArg = consoleSpy.mock.calls[0]?.[0];
      expect(callArg).toMatch(/\[LessDB\]/);

      consoleSpy.mockRestore();
    });
  });
});
