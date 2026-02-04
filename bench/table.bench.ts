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
    "update (partial)",
    async () => {
      await db.table<User, number>("users").update(1, { age: 30 });
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

  bench(
    "bulkUpdate 100 records",
    async () => {
      const updates = Array.from({ length: 100 }, (_, i) => ({
        key: i + 1,
        changes: { age: 50 },
      }));
      await db.table<User, number>("users").bulkUpdate(updates);
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
    "clear table (100 records)",
    async () => {
      await db.table<User, number>("users").clear();
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

  bench(
    "last",
    async () => {
      await db.table<User, number>("users").orderBy("age").last();
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
    "primaryKeys",
    async () => {
      await db.table<User, number>("users").where("age").equals(25).primaryKeys();
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

describe("where clause operators", () => {
  bench(
    "where anyOf (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").anyOf([25, 30, 35, 40]).toArray();
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
    "where above (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").above(60).toArray();
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
    "where below (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").below(25).toArray();
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
    "where aboveOrEqual (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").aboveOrEqual(60).toArray();
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
    "where belowOrEqual (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").belowOrEqual(25).toArray();
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
    "where notEqual (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").notEqual(25).toArray();
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
    "where noneOf (indexed)",
    async () => {
      await db.table<User, number>("users").where("age").noneOf([25, 30, 35, 40]).toArray();
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
    "where startsWith (indexed)",
    async () => {
      await db.table<User, number>("users").where("name").startsWith("user1").toArray();
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
    "where equalsIgnoreCase",
    async () => {
      await db.table<User, number>("users").where("name").equalsIgnoreCase("USER50").toArray();
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
    "where startsWithIgnoreCase",
    async () => {
      await db.table<User, number>("users").where("name").startsWithIgnoreCase("USER1").toArray();
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
    "where inAnyRange (indexed)",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .inAnyRange([
          [20, 25],
          [40, 45],
          [60, 65],
        ])
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
});

describe("collection chaining", () => {
  bench(
    "offset + limit",
    async () => {
      await db.table<User, number>("users").toCollection().offset(100).limit(50).toArray();
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
    "reverse",
    async () => {
      await db.table<User, number>("users").orderBy("age").reverse().limit(100).toArray();
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
    "where + filter",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .between(20, 40)
        .filter((u) => u.name.includes("5"))
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
    "where + limit + offset + reverse",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .between(20, 50)
        .reverse()
        .offset(10)
        .limit(20)
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
    "sortBy (in-memory)",
    async () => {
      await db
        .table<User, number>("users")
        .filter((u) => u.age > 40)
        .sortBy("name");
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

describe("or queries", () => {
  bench(
    "or equals (two indexes)",
    async () => {
      await db.table<User, number>("users").where("age").equals(25).or("age").equals(35).toArray();
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
    "or between (two ranges)",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .between(20, 25)
        .or("age")
        .between(50, 60)
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
    "or across different indexes",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .equals(25)
        .or("name")
        .startsWith("user5")
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
    "or with three clauses",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .equals(25)
        .or("age")
        .equals(35)
        .or("age")
        .equals(45)
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
});

describe("collection modifications", () => {
  bench(
    "modify (object changes)",
    async () => {
      await db.table<User, number>("users").where("age").equals(25).modify({ age: 26 });
    },
    {
      iterations: 20,
      warmupIterations: 2,
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
    "modify (function)",
    async () => {
      await db
        .table<User, number>("users")
        .where("age")
        .equals(25)
        .modify((user) => ({ age: user.age + 1 }));
    },
    {
      iterations: 20,
      warmupIterations: 2,
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
    "delete (where clause)",
    async () => {
      await db.table<User, number>("users").where("age").equals(25).delete();
    },
    {
      iterations: 20,
      warmupIterations: 2,
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
    "delete (filter)",
    async () => {
      await db
        .table<User, number>("users")
        .filter((u) => u.age === 25)
        .delete();
    },
    {
      iterations: 20,
      warmupIterations: 2,
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

interface Person {
  id?: number;
  firstName: string;
  lastName: string;
  age: number;
  city: string;
}

function generatePeople(count: number): Person[] {
  const firstNames = ["John", "Jane", "Bob", "Alice", "Charlie", "Diana", "Eve", "Frank"];
  const lastNames = ["Doe", "Smith", "Johnson", "Brown", "Wilson", "Davis", "Miller"];
  const cities = ["NYC", "LA", "Chicago", "Houston", "Phoenix", "Seattle", "Denver"];

  return Array.from({ length: count }, (_, i) => ({
    firstName: firstNames[i % firstNames.length] as string,
    lastName: lastNames[i % lastNames.length] as string,
    age: 20 + (i % 50),
    city: cities[i % cities.length] as string,
  }));
}

describe("compound index queries", () => {
  bench(
    "compound where equals",
    async () => {
      await db
        .table<Person, number>("people")
        .where("firstName+lastName")
        .equals(["John", "Doe"])
        .toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ people: "++id, [firstName+lastName], [city+age]" });
        await db.table<Person, number>("people").bulkAdd(generatePeople(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "compound where between",
    async () => {
      await db
        .table<Person, number>("people")
        .where("city+age")
        .between(["NYC", 20], ["NYC", 40])
        .toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ people: "++id, [firstName+lastName], [city+age]" });
        await db.table<Person, number>("people").bulkAdd(generatePeople(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "compound where anyOf",
    async () => {
      await db
        .table<Person, number>("people")
        .where("firstName+lastName")
        .anyOf([
          ["John", "Doe"],
          ["Jane", "Smith"],
          ["Bob", "Johnson"],
        ])
        .toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ people: "++id, [firstName+lastName], [city+age]" });
        await db.table<Person, number>("people").bulkAdd(generatePeople(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "compound orderBy",
    async () => {
      await db.table<Person, number>("people").orderBy("firstName+lastName").limit(100).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ people: "++id, [firstName+lastName], [city+age]" });
        await db.table<Person, number>("people").bulkAdd(generatePeople(1000));
      },
      teardown: async () => {
        await teardownDb();
      },
    },
  );

  bench(
    "compound or query",
    async () => {
      await db
        .table<Person, number>("people")
        .where("firstName+lastName")
        .equals(["John", "Doe"])
        .or("city+age")
        .equals(["LA", 25])
        .toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupDb({ people: "++id, [firstName+lastName], [city+age]" });
        await db.table<Person, number>("people").bulkAdd(generatePeople(1000));
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
