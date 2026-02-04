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
  // Allow pending operations to complete before delete
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    "update (partial)",
    async () => {
      await db.users.update(1, { age: 30 });
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

  bench(
    "bulkUpdate 100 records",
    async () => {
      const updates = Array.from({ length: 100 }, (_, i) => ({
        key: i + 1,
        changes: { age: 50 },
      }));
      await db.users.bulkUpdate(updates);
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
    "clear table (100 records)",
    async () => {
      await db.users.clear();
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

  bench(
    "last",
    async () => {
      await db.users.orderBy("age").last();
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
    "primaryKeys",
    async () => {
      await db.users.where("age").equals(25).primaryKeys();
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

describe("dexie where clause operators", () => {
  bench(
    "where anyOf (indexed)",
    async () => {
      await db.users.where("age").anyOf([25, 30, 35, 40]).toArray();
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
    "where above (indexed)",
    async () => {
      await db.users.where("age").above(60).toArray();
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
    "where below (indexed)",
    async () => {
      await db.users.where("age").below(25).toArray();
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
    "where aboveOrEqual (indexed)",
    async () => {
      await db.users.where("age").aboveOrEqual(60).toArray();
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
    "where belowOrEqual (indexed)",
    async () => {
      await db.users.where("age").belowOrEqual(25).toArray();
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
    "where notEqual (indexed)",
    async () => {
      await db.users.where("age").notEqual(25).toArray();
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
    "where noneOf (indexed)",
    async () => {
      await db.users.where("age").noneOf([25, 30, 35, 40]).toArray();
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
    "where startsWith (indexed)",
    async () => {
      await db.users.where("name").startsWith("user1").toArray();
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
    "where equalsIgnoreCase",
    async () => {
      await db.users.where("name").equalsIgnoreCase("USER50").toArray();
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
    "where startsWithIgnoreCase",
    async () => {
      await db.users.where("name").startsWithIgnoreCase("USER1").toArray();
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
    "where inAnyRange (indexed)",
    async () => {
      await db.users
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
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );
});

describe("dexie collection chaining", () => {
  bench(
    "offset + limit",
    async () => {
      await db.users.offset(100).limit(50).toArray();
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
    "reverse",
    async () => {
      await db.users.orderBy("age").reverse().limit(100).toArray();
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
    "where + filter",
    async () => {
      await db.users
        .where("age")
        .between(20, 40)
        .filter((u) => u.name.includes("5"))
        .toArray();
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
    "where + limit + offset + reverse",
    async () => {
      await db.users.where("age").between(20, 50).reverse().offset(10).limit(20).toArray();
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
    "sortBy (in-memory)",
    async () => {
      await db.users.filter((u) => u.age > 40).sortBy("name");
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

describe("dexie or queries", () => {
  bench(
    "or equals (two indexes)",
    async () => {
      await db.users.where("age").equals(25).or("age").equals(35).toArray();
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
    "or between (two ranges)",
    async () => {
      await db.users.where("age").between(20, 25).or("age").between(50, 60).toArray();
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
    "or across different indexes",
    async () => {
      await db.users.where("age").equals(25).or("name").startsWith("user5").toArray();
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
    "or with three clauses",
    async () => {
      await db.users.where("age").equals(25).or("age").equals(35).or("age").equals(45).toArray();
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

describe("dexie collection modifications", () => {
  bench(
    "modify (object changes)",
    async () => {
      await db.users.where("age").equals(25).modify({ age: 26 });
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "modify (function)",
    async () => {
      await db.users
        .where("age")
        .equals(25)
        .modify((user) => {
          user.age = user.age + 1;
        });
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "delete (where clause)",
    async () => {
      await db.users.where("age").equals(25).delete();
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
    },
  );

  bench(
    "delete (filter)",
    async () => {
      await db.users.filter((u) => u.age === 25).delete();
    },
    {
      iterations: 20,
      warmupIterations: 2,
      setup: async () => {
        await setupDb();
        await db.users.bulkAdd(generateUsers(1000));
      },
      teardown: teardownDb,
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

let peopleDb: Dexie & { people: Table<Person, number> };
let peopleDbName: string;
let peopleCounter = 0;

async function setupPeopleDb() {
  peopleDbName = `dexie-people-bench-${Date.now()}-${peopleCounter++}`;
  peopleDb = new Dexie(peopleDbName) as Dexie & { people: Table<Person, number> };
  peopleDb.version(1).stores({ people: "++id, [firstName+lastName], [city+age]" });
  await peopleDb.open();
}

async function teardownPeopleDb() {
  peopleDb.close();
  // Allow pending operations to complete before delete
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Dexie.delete(peopleDbName);
}

describe("dexie compound index queries", () => {
  bench(
    "compound where equals",
    async () => {
      await peopleDb.people.where("[firstName+lastName]").equals(["John", "Doe"]).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupPeopleDb();
        await peopleDb.people.bulkAdd(generatePeople(1000));
      },
      teardown: teardownPeopleDb,
    },
  );

  bench(
    "compound where between",
    async () => {
      await peopleDb.people.where("[city+age]").between(["NYC", 20], ["NYC", 40]).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupPeopleDb();
        await peopleDb.people.bulkAdd(generatePeople(1000));
      },
      teardown: teardownPeopleDb,
    },
  );

  bench(
    "compound where anyOf",
    async () => {
      await peopleDb.people
        .where("[firstName+lastName]")
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
        await setupPeopleDb();
        await peopleDb.people.bulkAdd(generatePeople(1000));
      },
      teardown: teardownPeopleDb,
    },
  );

  bench(
    "compound orderBy",
    async () => {
      await peopleDb.people.orderBy("[firstName+lastName]").limit(100).toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupPeopleDb();
        await peopleDb.people.bulkAdd(generatePeople(1000));
      },
      teardown: teardownPeopleDb,
    },
  );

  bench(
    "compound or query",
    async () => {
      await peopleDb.people
        .where("[firstName+lastName]")
        .equals(["John", "Doe"])
        .or("[city+age]")
        .equals(["LA", 25])
        .toArray();
    },
    {
      iterations: 30,
      warmupIterations: 3,
      setup: async () => {
        await setupPeopleDb();
        await peopleDb.people.bulkAdd(generatePeople(1000));
      },
      teardown: teardownPeopleDb,
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
