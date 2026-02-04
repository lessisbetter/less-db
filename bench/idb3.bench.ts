/**
 * IndexedDB 3.0 Feature Benchmarks
 *
 * Tests the performance of IndexedDB 3.0 optimizations:
 * - openKeyCursor() for keys-only queries
 * - nextunique/prevunique cursor directions
 * - Transaction durability hints
 * - Explicit commit()
 *
 * Run with: pnpm bench:idb3
 */

import { bench, describe } from "vitest";
import { LessDB } from "../src/index.js";

interface User {
  id?: number;
  name: string;
  email: string;
  age: number;
  category: string;
}

function generateUsers(count: number): User[] {
  const categories = ["admin", "user", "guest", "moderator", "support"];
  return Array.from({ length: count }, (_, i) => ({
    name: `user${i}`,
    email: `user${i}@example.com`,
    age: 20 + (i % 50),
    category: categories[i % categories.length]!,
  }));
}

let db: LessDB;
let dbName: string;
let counter = 0;

async function setupDb(recordCount: number = 1000) {
  dbName = `idb3-bench-${Date.now()}-${counter++}`;
  db = new LessDB(dbName);
  db.version(1).stores({
    users: "++id, name, email, age, category",
  });
  await db.open();
  await db.table<User, number>("users").bulkAdd(generateUsers(recordCount));
}

async function teardownDb() {
  db.close();
  await indexedDB.deleteDatabase(dbName);
}

// ============================================
// openKeyCursor optimization benchmarks
// These test keys-only queries which use openKeyCursor internally
// ============================================

describe("openKeyCursor optimization (keys-only queries)", () => {
  describe("1k records", () => {
    bench(
      "primaryKeys() - keys only",
      async () => {
        await db.table<User, number>("users").where("age").equals(25).primaryKeys();
      },
      {
        iterations: 50,
        warmupIterations: 5,
        setup: () => setupDb(1000),
        teardown: teardownDb,
      },
    );

    bench(
      "toArray() - with values",
      async () => {
        await db.table<User, number>("users").where("age").equals(25).toArray();
      },
      {
        iterations: 50,
        warmupIterations: 5,
        setup: () => setupDb(1000),
        teardown: teardownDb,
      },
    );

    bench(
      "eachPrimaryKey() - keys only iteration",
      async () => {
        const keys: number[] = [];
        await db
          .table<User, number>("users")
          .where("age")
          .above(40)
          .eachPrimaryKey((key) => {
            keys.push(key as number);
          });
      },
      {
        iterations: 50,
        warmupIterations: 5,
        setup: () => setupDb(1000),
        teardown: teardownDb,
      },
    );

    bench(
      "each() - with values iteration",
      async () => {
        const users: User[] = [];
        await db
          .table<User, number>("users")
          .where("age")
          .above(40)
          .each((user) => {
            users.push(user);
          });
      },
      {
        iterations: 50,
        warmupIterations: 5,
        setup: () => setupDb(1000),
        teardown: teardownDb,
      },
    );
  });

  describe("10k records", () => {
    bench(
      "primaryKeys() 10k - keys only",
      async () => {
        await db.table<User, number>("users").where("age").above(30).primaryKeys();
      },
      {
        iterations: 20,
        warmupIterations: 2,
        setup: () => setupDb(10000),
        teardown: teardownDb,
      },
    );

    bench(
      "toArray() 10k - with values",
      async () => {
        await db.table<User, number>("users").where("age").above(30).toArray();
      },
      {
        iterations: 20,
        warmupIterations: 2,
        setup: () => setupDb(10000),
        teardown: teardownDb,
      },
    );

    bench(
      "count() 10k - no values needed",
      async () => {
        await db.table<User, number>("users").where("age").above(30).count();
      },
      {
        iterations: 20,
        warmupIterations: 2,
        setup: () => setupDb(10000),
        teardown: teardownDb,
      },
    );
  });

  describe("50k records", () => {
    bench(
      "primaryKeys() 50k - keys only",
      async () => {
        await db.table<User, number>("users").where("age").equals(25).primaryKeys();
      },
      {
        iterations: 10,
        warmupIterations: 1,
        setup: () => setupDb(50000),
        teardown: teardownDb,
      },
    );

    bench(
      "toArray() 50k - with values",
      async () => {
        await db.table<User, number>("users").where("age").equals(25).toArray();
      },
      {
        iterations: 10,
        warmupIterations: 1,
        setup: () => setupDb(50000),
        teardown: teardownDb,
      },
    );
  });
});

// ============================================
// Transaction durability benchmarks
// ============================================

describe("transaction durability hints", () => {
  bench(
    "durability: default",
    async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").add({
            name: "test",
            email: "test@test.com",
            age: 30,
            category: "user",
          });
        },
        { durability: "default" },
      );
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(100),
      teardown: teardownDb,
    },
  );

  bench(
    "durability: relaxed",
    async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").add({
            name: "test",
            email: "test@test.com",
            age: 30,
            category: "user",
          });
        },
        { durability: "relaxed" },
      );
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(100),
      teardown: teardownDb,
    },
  );

  bench(
    "durability: strict",
    async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").add({
            name: "test",
            email: "test@test.com",
            age: 30,
            category: "user",
          });
        },
        { durability: "strict" },
      );
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(100),
      teardown: teardownDb,
    },
  );

  bench(
    "no durability option (implicit default)",
    async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        await tx.table<User, number>("users").add({
          name: "test",
          email: "test@test.com",
          age: 30,
          category: "user",
        });
      });
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(100),
      teardown: teardownDb,
    },
  );
});

describe("bulk writes with durability", () => {
  bench(
    "bulkAdd 100 - durability: relaxed",
    async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").bulkAdd(generateUsers(100));
        },
        { durability: "relaxed" },
      );
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: () => setupDb(0),
      teardown: teardownDb,
    },
  );

  bench(
    "bulkAdd 100 - durability: strict",
    async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").bulkAdd(generateUsers(100));
        },
        { durability: "strict" },
      );
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: () => setupDb(0),
      teardown: teardownDb,
    },
  );

  bench(
    "bulkAdd 100 - no durability option",
    async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        await tx.table<User, number>("users").bulkAdd(generateUsers(100));
      });
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: () => setupDb(0),
      teardown: teardownDb,
    },
  );
});

// ============================================
// Explicit commit() benchmarks
// ============================================

describe("explicit commit()", () => {
  bench(
    "with explicit commit()",
    async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        await tx.table<User, number>("users").add({
          name: "test",
          email: "test@test.com",
          age: 30,
          category: "user",
        });
        tx.commit();
      });
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(100),
      teardown: teardownDb,
    },
  );

  bench(
    "without explicit commit (auto-commit)",
    async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        await tx.table<User, number>("users").add({
          name: "test",
          email: "test@test.com",
          age: 30,
          category: "user",
        });
      });
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(100),
      teardown: teardownDb,
    },
  );

  bench(
    "bulk ops with explicit commit()",
    async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        const table = tx.table<User, number>("users");
        await table.bulkAdd(generateUsers(50));
        tx.commit();
      });
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: () => setupDb(0),
      teardown: teardownDb,
    },
  );

  bench(
    "bulk ops without explicit commit",
    async () => {
      await db.transaction("rw", ["users"], async (tx) => {
        const table = tx.table<User, number>("users");
        await table.bulkAdd(generateUsers(50));
      });
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: () => setupDb(0),
      teardown: teardownDb,
    },
  );
});

// ============================================
// Cursor direction benchmarks (unique filtering)
// ============================================

describe("cursor directions (reverse queries)", () => {
  bench(
    "orderBy forward",
    async () => {
      await db.table<User, number>("users").orderBy("age").limit(100).toArray();
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(1000),
      teardown: teardownDb,
    },
  );

  bench(
    "orderBy reverse",
    async () => {
      await db.table<User, number>("users").orderBy("age").reverse().limit(100).toArray();
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(1000),
      teardown: teardownDb,
    },
  );

  bench(
    "where + reverse",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .between(20, 50)
        .reverse()
        .limit(100)
        .toArray();
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(1000),
      teardown: teardownDb,
    },
  );

  bench(
    "first() - forward cursor",
    async () => {
      await db.table<User, number>("users").orderBy("age").first();
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(1000),
      teardown: teardownDb,
    },
  );

  bench(
    "last() - reverse cursor",
    async () => {
      await db.table<User, number>("users").orderBy("age").last();
    },
    {
      iterations: 50,
      warmupIterations: 5,
      setup: () => setupDb(1000),
      teardown: teardownDb,
    },
  );
});

// ============================================
// Combined optimizations
// ============================================

describe("combined optimizations", () => {
  bench(
    "relaxed durability + explicit commit + bulk write",
    async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").bulkAdd(generateUsers(100));
          tx.commit();
        },
        { durability: "relaxed" },
      );
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: () => setupDb(0),
      teardown: teardownDb,
    },
  );

  bench(
    "strict durability + auto commit + bulk write",
    async () => {
      await db.transaction(
        "rw",
        ["users"],
        async (tx) => {
          await tx.table<User, number>("users").bulkAdd(generateUsers(100));
        },
        { durability: "strict" },
      );
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: () => setupDb(0),
      teardown: teardownDb,
    },
  );

  bench(
    "keys-only query on large dataset",
    async () => {
      await db.table<User, number>("users").where("category").equals("admin").primaryKeys();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: () => setupDb(10000),
      teardown: teardownDb,
    },
  );

  bench(
    "full values query on large dataset",
    async () => {
      await db.table<User, number>("users").where("category").equals("admin").toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: () => setupDb(10000),
      teardown: teardownDb,
    },
  );
});
