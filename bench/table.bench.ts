import { bench, describe } from "vitest";
import { LessDB } from "../src/index.js";

interface User {
  id?: number;
  name: string;
  email: string;
  age: number;
}

function generateUsers(count: number): User[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `user${i}`,
    email: `user${i}@example.com`,
    age: 20 + (i % 50),
  }));
}

// Shared state for benchmarks
let db: LessDB;
let dbName: string;
let counter = 0;

async function setupDb(schema: Record<string, string>) {
  dbName = `bench-${Date.now()}-${counter++}`;
  db = new LessDB(dbName);
  db.version(1).stores(schema);
  await db.open();
}

async function teardownDb() {
  db.close();
  await indexedDB.deleteDatabase(dbName);
}

describe("single operations", () => {
  bench(
    "add single record",
    async () => {
      await db.table<User, number>("users").add({
        name: "test",
        email: "test@example.com",
        age: 25,
      });
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "get by primary key",
    async () => {
      await db.table<User, number>("users").get(1);
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        // Seed a record to get
        await db.table<User, number>("users").add({
          name: "test",
          email: "test@example.com",
          age: 25,
        });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "put (upsert)",
    async () => {
      await db.table<User, number>("users").put({
        id: 1,
        name: "test",
        email: "test@example.com",
        age: 25,
      });
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "delete by primary key",
    async () => {
      await db.table<User, number>("users").delete(1);
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").add({
          name: "test",
          email: "test@example.com",
          age: 25,
        });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );
});

describe("bulk operations", () => {
  bench(
    "bulkAdd 100 records",
    async () => {
      const users = generateUsers(100);
      await db.table<User, number>("users").bulkAdd(users);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "bulkAdd 1000 records",
    async () => {
      const users = generateUsers(1000);
      await db.table<User, number>("users").bulkAdd(users);
    },
    {
      iterations: 10,
      warmupIterations: 1,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "bulkGet 100 records",
    async () => {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);
      await db.table<User, number>("users").bulkGet(ids);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(100));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "bulkPut 100 records",
    async () => {
      const users = generateUsers(100).map((u, i) => ({ ...u, id: i + 1 }));
      await db.table<User, number>("users").bulkPut(users);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "bulkDelete 100 records",
    async () => {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);
      await db.table<User, number>("users").bulkDelete(ids);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(100));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );
});

describe("query operations", () => {
  bench(
    "where equals (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").equals(25).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "where between (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").between(20, 30).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "filter (non-indexed)",
    async () => {
      await db
        .table<User, number>("users")
        .filter((u) => u.name.startsWith("user1"))
        .toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "toArray all records",
    async () => {
      await db.table<User, number>("users").toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "count",
    async () => {
      await db.table<User, number>("users").count();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "limit 10",
    async () => {
      await db.table<User, number>("users").toCollection().limit(10).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "first",
    async () => {
      await db.table<User, number>("users").orderBy("age").first();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );
});

describe("large scale (10k records)", () => {
  bench(
    "bulkAdd 10000 records",
    async () => {
      const users = generateUsers(10000);
      await db.table<User, number>("users").bulkAdd(users);
    },
    {
      iterations: 5,
      warmupIterations: 1,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "toArray 10000 records",
    async () => {
      await db.table<User, number>("users").toArray();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(10000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "where equals 10000 records",
    async () => {
      await db.table<User, number>("users").where("age").equals(25).toArray();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(10000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "filter 10000 records",
    async () => {
      await db
        .table<User, number>("users")
        .filter((u) => u.name.startsWith("user1"))
        .toArray();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(10000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "count 10000 records",
    async () => {
      await db.table<User, number>("users").count();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb({ users: "++id, name, email, age" });
        await db.table<User, number>("users").bulkAdd(generateUsers(10000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );
});
