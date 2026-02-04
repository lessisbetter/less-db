/**
 * Tests for the middleware system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LessDB,
  type Middleware,
  type DBCore,
  type DBCoreTable,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
} from "../src/index.js";

interface User {
  id?: number;
  name: string;
  email: string;
}

describe("middleware", () => {
  let db: LessDB;
  let dbName: string;

  beforeEach(() => {
    dbName = `test-middleware-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = new LessDB(dbName);
    db.version(1).stores({ users: "++id, name, &email" });
  });

  afterEach(async () => {
    if (db.isOpen) {
      db.close();
    }
    await new LessDB(dbName).delete().catch(() => {});
  });

  describe("registration", () => {
    it("can register middleware before open", async () => {
      const log: string[] = [];

      const loggingMiddleware: Middleware = {
        stack: "dbcore",
        name: "logging",
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  log.push(`mutate:${req.type}:${name}`);
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      db.use(loggingMiddleware);
      await db.open();

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });

      expect(log).toContain("mutate:add:users");
    });

    it("can register middleware after open", async () => {
      await db.open();

      const log: string[] = [];
      const loggingMiddleware: Middleware = {
        stack: "dbcore",
        name: "logging",
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  log.push(`mutate:${req.type}`);
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      db.use(loggingMiddleware);

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });

      expect(log).toContain("mutate:add");
    });

    it("replaces middleware with same name", async () => {
      const log: string[] = [];

      const middleware1: Middleware = {
        stack: "dbcore",
        name: "tracker",
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  log.push("v1");
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      const middleware2: Middleware = {
        stack: "dbcore",
        name: "tracker",
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  log.push("v2");
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      db.use(middleware1);
      db.use(middleware2);
      await db.open();

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });

      expect(log).toEqual(["v2"]); // Only v2, v1 was replaced
    });
  });

  describe("unuse", () => {
    it("removes middleware by reference", async () => {
      const log: string[] = [];

      const middleware: Middleware = {
        stack: "dbcore",
        name: "tracker",
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  log.push("tracked");
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      db.use(middleware);
      await db.open();

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });
      expect(log).toContain("tracked");

      log.length = 0;
      db.unuse(middleware);

      await db.table<User, number>("users").add({ name: "Bob", email: "bob@test.com" });
      expect(log).not.toContain("tracked");
    });

    it("removes middleware by name", async () => {
      const log: string[] = [];

      db.use({
        stack: "dbcore",
        name: "tracker",
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  log.push("tracked");
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      });
      await db.open();

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });
      expect(log).toContain("tracked");

      log.length = 0;
      db.unuse({ stack: "dbcore", name: "tracker" });

      await db.table<User, number>("users").add({ name: "Bob", email: "bob@test.com" });
      expect(log).not.toContain("tracked");
    });
  });

  describe("middleware ordering", () => {
    it("executes middleware in level order (lowest = closest to IndexedDB)", async () => {
      const order: string[] = [];

      const highLevel: Middleware = {
        stack: "dbcore",
        name: "high",
        level: 20,
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  order.push("high-before");
                  const result = await downTable.mutate(req);
                  order.push("high-after");
                  return result;
                },
              };
            },
          };
        },
      };

      const lowLevel: Middleware = {
        stack: "dbcore",
        name: "low",
        level: 5,
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  order.push("low-before");
                  const result = await downTable.mutate(req);
                  order.push("low-after");
                  return result;
                },
              };
            },
          };
        },
      };

      // Register in reverse order - should still execute by level
      db.use(highLevel);
      db.use(lowLevel);
      await db.open();

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });

      // Higher level middleware is applied later in chain, so it runs first
      // (outermost in the call stack). Lower level is closer to IndexedDB (innermost).
      expect(order).toEqual(["high-before", "low-before", "low-after", "high-after"]);
    });

    it("uses default level of 10 when not specified", async () => {
      const order: string[] = [];

      const explicitLevel5: Middleware = {
        stack: "dbcore",
        name: "explicit5",
        level: 5,
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  order.push("level5");
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      const defaultLevel: Middleware = {
        stack: "dbcore",
        name: "default",
        // no level specified = 10
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  order.push("default");
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      db.use(defaultLevel);
      db.use(explicitLevel5);
      await db.open();

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });

      // Default level (10) > explicit level (5), so default executes first (outer)
      expect(order.indexOf("default")).toBeLessThan(order.indexOf("level5"));
    });
  });

  describe("middleware chains", () => {
    it("multiple middleware form a chain", async () => {
      const calls: string[] = [];

      const middleware1: Middleware = {
        stack: "dbcore",
        name: "m1",
        level: 1,
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  calls.push("m1-start");
                  const result = await downTable.mutate(req);
                  calls.push("m1-end");
                  return result;
                },
              };
            },
          };
        },
      };

      const middleware2: Middleware = {
        stack: "dbcore",
        name: "m2",
        level: 2,
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  calls.push("m2-start");
                  const result = await downTable.mutate(req);
                  calls.push("m2-end");
                  return result;
                },
              };
            },
          };
        },
      };

      const middleware3: Middleware = {
        stack: "dbcore",
        name: "m3",
        level: 3,
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  calls.push("m3-start");
                  const result = await downTable.mutate(req);
                  calls.push("m3-end");
                  return result;
                },
              };
            },
          };
        },
      };

      db.use(middleware3);
      db.use(middleware1);
      db.use(middleware2);
      await db.open();

      await db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" });

      // Higher level middleware runs first (outermost), lower level is closest to IndexedDB
      expect(calls).toEqual(["m3-start", "m2-start", "m1-start", "m1-end", "m2-end", "m3-end"]);
    });
  });

  describe("error propagation", () => {
    it("propagates errors from middleware", async () => {
      const errorMiddleware: Middleware = {
        stack: "dbcore",
        name: "error",
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(_req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  throw new Error("Middleware error");
                },
              };
            },
          };
        },
      };

      db.use(errorMiddleware);
      await db.open();

      await expect(
        db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" }),
      ).rejects.toThrow("Middleware error");
    });

    it("inner middleware does not execute when outer throws", async () => {
      const calls: string[] = [];

      // Higher level (outer) middleware that throws
      const throwingMiddleware: Middleware = {
        stack: "dbcore",
        name: "thrower",
        level: 10, // Higher level = outer (runs first)
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(_req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  calls.push("throwing");
                  throw new Error("Stop here");
                },
              };
            },
          };
        },
      };

      // Lower level (inner) middleware that should never be reached
      const neverCalledMiddleware: Middleware = {
        stack: "dbcore",
        name: "never",
        level: 1, // Lower level = inner (closer to IndexedDB)
        create(downCore: DBCore) {
          return {
            table(name: string): DBCoreTable {
              const downTable = downCore.table(name);
              return {
                ...downTable,
                async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
                  calls.push("never-called");
                  return downTable.mutate(req);
                },
              };
            },
          };
        },
      };

      db.use(throwingMiddleware);
      db.use(neverCalledMiddleware);
      await db.open();

      await expect(
        db.table<User, number>("users").add({ name: "Alice", email: "alice@test.com" }),
      ).rejects.toThrow("Stop here");

      expect(calls).toEqual(["throwing"]);
      expect(calls).not.toContain("never-called");
    });
  });
});
