import { bench, describe } from "vitest";
import Dexie, { type Table } from "dexie";

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
let db: Dexie & { users: Table<User, number> };
let dbName: string;
let counter = 0;

async function setupDb() {
  dbName = `dexie-bench-${Date.now()}-${counter++}`;
  db = new Dexie(dbName) as Dexie & { users: Table<User, number> };
  db.version(1).stores({ users: "++id, name, email, age" });
  await db.open();
}

async function teardownDb() {
  db.close();
  await Dexie.delete(dbName);
}

describe("dexie single operations", () => {
  bench(
    "add single record",
    async () => {
      await db.users.add({
        name: "test",
        email: "test@example.com",
        age: 25,
      });
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: setupDb,
      teardown: teardownDb,
    },
  );

  bench(
    "get by primary key",
    async () => {
      await db.users.get(1);
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: async () => {
        await setupDb();
        await db.users.add({
          name: "test",
          email: "test@example.com",
          age: 25,
        });
      },
      teardown: teardownDb,
    },
  );

  bench(
    "put (upsert)",
    async () => {
      await db.users.put({
        id: 1,
        name: "test",
        email: "test@example.com",
        age: 25,
      });
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: setupDb,
      teardown: teardownDb,
    },
  );

  bench(
    "delete by primary key",
    async () => {
      await db.users.delete(1);
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: async () => {
        await setupDb();
        await db.users.add({
          name: "test",
          email: "test@example.com",
          age: 25,
        });
      },
      teardown: teardownDb,
    },
  );
});

describe("dexie bulk operations", () => {
  bench(
    "bulkAdd 100 records",
    async () => {
      const users = generateUsers(100);
      await db.users.bulkAdd(users);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: setupDb,
      teardown: teardownDb,
    },
  );

  bench(
    "bulkAdd 1000 records",
    async () => {
      const users = generateUsers(1000);
      await db.users.bulkAdd(users);
    },
    {
      iterations: 10,
      warmupIterations: 1,
      setup: setupDb,
      teardown: teardownDb,
    },
  );

  bench(
    "bulkGet 100 records",
    async () => {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);
      await db.users.bulkGet(ids);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(100));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "bulkPut 100 records",
    async () => {
      const users = generateUsers(100).map((u, i) => ({ ...u, id: i + 1 }));
      await db.users.bulkPut(users);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: setupDb,
      teardown: teardownDb,
    },
  );

  bench(
    "bulkDelete 100 records",
    async () => {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);
      await db.users.bulkDelete(ids);
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(100));
      },
      teardown: teardownDb,
    },
  );
});

describe("dexie query operations", () => {
  bench(
    "where equals (indexed)",
    async () => {
      await db.users.where("age").equals(25).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "where between (indexed)",
    async () => {
      await db.users.where("age").between(20, 30).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "filter (non-indexed)",
    async () => {
      await db.users.filter((u) => u.name.startsWith("user1")).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "toArray all records",
    async () => {
      await db.users.toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "count",
    async () => {
      await db.users.count();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "limit 10",
    async () => {
      await db.users.limit(10).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "first",
    async () => {
      await db.users.orderBy("age").first();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );
});

describe("dexie large scale (10k records)", () => {
  bench(
    "bulkAdd 10000 records",
    async () => {
      const users = generateUsers(10000);
      await db.users.bulkAdd(users);
    },
    {
      iterations: 5,
      warmupIterations: 1,
      setup: setupDb,
      teardown: teardownDb,
    },
  );

  bench(
    "toArray 10000 records",
    async () => {
      await db.users.toArray();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(10000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "where equals 10000 records",
    async () => {
      await db.users.where("age").equals(25).toArray();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(10000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "filter 10000 records",
    async () => {
      await db.users.filter((u) => u.name.startsWith("user1")).toArray();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(10000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "count 10000 records",
    async () => {
      await db.users.count();
    },
    {
      iterations: 10,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(10000));
      },
      teardown: teardownDb,
    },
  );
});
