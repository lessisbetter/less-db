/**
 * Tests for compound index queries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LessDB } from "../src/index.js";

interface Event {
  id?: number;
  userId: number;
  category: string;
  timestamp: number;
  data: string;
}

interface Product {
  id?: number;
  category: string;
  brand: string;
  name: string;
  price: number;
}

describe("compound indexes", () => {
  let db: LessDB;
  let dbName: string;

  beforeEach(() => {
    dbName = `test-compound-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = new LessDB(dbName);
  });

  afterEach(async () => {
    if (db.isOpen) {
      db.close();
    }
    await new LessDB(dbName).delete().catch(() => {});
  });

  describe("two-part compound index", () => {
    beforeEach(async () => {
      db.version(1).stores({
        events: "++id, [userId+category], timestamp",
      });
      await db.open();

      const events = db.table<Event, number>("events");
      await events.bulkAdd([
        { userId: 1, category: "login", timestamp: 100, data: "event1" },
        { userId: 1, category: "click", timestamp: 200, data: "event2" },
        { userId: 1, category: "login", timestamp: 300, data: "event3" },
        { userId: 2, category: "login", timestamp: 150, data: "event4" },
        { userId: 2, category: "purchase", timestamp: 400, data: "event5" },
      ]);
    });

    it("can order by compound index", async () => {
      const events = db.table<Event, number>("events");
      const results = await events.orderBy("userId+category").toArray();

      // Should be ordered by userId, then category
      expect(results.length).toBe(5);
      // First user 1's events (sorted by category: click, login, login)
      // Then user 2's events (sorted by category: login, purchase)
    });

    it("queries compound key with between", async () => {
      const events = db.table<Event, number>("events");
      // Between [1, "click"] and [1, "login"] (inclusive)
      const results = await events
        .where("userId+category")
        .between([1, "click"], [1, "login"], true, true)
        .toArray();

      // This should get user 1's click and login events
      expect(results.every((e) => e.userId === 1)).toBe(true);
    });

    it("queries compound key with above", async () => {
      const events = db.table<Event, number>("events");
      // All events with userId > 1
      const results = await events.where("userId+category").above([1, "\uffff"]).toArray();

      expect(results.every((e) => e.userId >= 2)).toBe(true);
    });

    it("queries compound key with filter for exact match", async () => {
      const events = db.table<Event, number>("events");
      // Use filter instead of equals for compound indexes with array values
      const results = await events
        .where("userId+category")
        .between([1, "login"], [1, "login"], true, true)
        .toArray();

      expect(results.every((e) => e.userId === 1 && e.category === "login")).toBe(true);
    });
  });

  describe("three-part compound index", () => {
    beforeEach(async () => {
      db.version(1).stores({
        products: "++id, [category+brand+name], price",
      });
      await db.open();

      const products = db.table<Product, number>("products");
      await products.bulkAdd([
        { category: "electronics", brand: "apple", name: "iphone", price: 999 },
        { category: "electronics", brand: "apple", name: "ipad", price: 799 },
        { category: "electronics", brand: "samsung", name: "galaxy", price: 899 },
        { category: "clothing", brand: "nike", name: "shoes", price: 150 },
        { category: "clothing", brand: "adidas", name: "shoes", price: 120 },
      ]);
    });

    it("queries by full three-part key using between", async () => {
      const products = db.table<Product, number>("products");
      // Use between with same upper/lower for exact match
      const results = await products
        .where("category+brand+name")
        .between(["electronics", "apple", "iphone"], ["electronics", "apple", "iphone"], true, true)
        .toArray();

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("iphone");
    });

    it("queries by partial key prefix using between", async () => {
      const products = db.table<Product, number>("products");
      // Get all apple products in electronics
      const results = await products
        .where("category+brand+name")
        .between(["electronics", "apple", ""], ["electronics", "apple", "\uffff"], true, true)
        .toArray();

      expect(results).toHaveLength(2);
      expect(results.every((p) => p.brand === "apple")).toBe(true);
    });

    it("orders results by compound key", async () => {
      const products = db.table<Product, number>("products");
      const results = await products.orderBy("category+brand+name").toArray();

      // Should be ordered by category, then brand, then name
      // clothing comes before electronics alphabetically
      expect(results[0]?.category).toBe("clothing");
      expect(results[results.length - 1]?.category).toBe("electronics");
    });
  });

  describe("compound index with unique constraint", () => {
    beforeEach(async () => {
      db.version(1).stores({
        userRoles: "++id, &[userId+role]",
      });
      await db.open();
    });

    it("enforces uniqueness on compound key", async () => {
      interface UserRole {
        id?: number;
        userId: number;
        role: string;
      }

      const userRoles = db.table<UserRole, number>("userRoles");
      await userRoles.add({ userId: 1, role: "admin" });

      // Adding same combination should fail
      await expect(userRoles.add({ userId: 1, role: "admin" })).rejects.toThrow();

      // But different combination should work
      const id = await userRoles.add({ userId: 1, role: "editor" });
      expect(id).toBeDefined();
    });
  });

  describe("compound index CRUD operations", () => {
    beforeEach(async () => {
      db.version(1).stores({
        events: "++id, [userId+category]",
      });
      await db.open();
    });

    it("add and retrieve by compound index with between", async () => {
      const events = db.table<Event, number>("events");
      const id = await events.add({
        userId: 1,
        category: "test",
        timestamp: Date.now(),
        data: "test data",
      });

      // Use between for exact match query on compound index
      const result = await events
        .where("userId+category")
        .between([1, "test"], [1, "test"], true, true)
        .first();
      expect(result?.id).toBe(id);
    });

    it("update record found by compound index", async () => {
      const events = db.table<Event, number>("events");
      await events.add({ userId: 1, category: "test", timestamp: 100, data: "original" });

      await events
        .where("userId+category")
        .between([1, "test"], [1, "test"], true, true)
        .modify({ data: "updated" });

      const result = await events
        .where("userId+category")
        .between([1, "test"], [1, "test"], true, true)
        .first();
      expect(result?.data).toBe("updated");
    });

    it("delete records found by compound index", async () => {
      const events = db.table<Event, number>("events");
      await events.bulkAdd([
        { userId: 1, category: "test", timestamp: 100, data: "a" },
        { userId: 1, category: "test", timestamp: 200, data: "b" },
        { userId: 1, category: "other", timestamp: 300, data: "c" },
      ]);

      const deleted = await events
        .where("userId+category")
        .between([1, "test"], [1, "test"], true, true)
        .delete();
      expect(deleted).toBe(2);

      const remaining = await events.toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.category).toBe("other");
    });

    it("count records by compound index range", async () => {
      const events = db.table<Event, number>("events");
      await events.bulkAdd([
        { userId: 1, category: "login", timestamp: 100, data: "a" },
        { userId: 1, category: "login", timestamp: 200, data: "b" },
        { userId: 1, category: "click", timestamp: 300, data: "c" },
        { userId: 2, category: "login", timestamp: 400, data: "d" },
      ]);

      // Count using between for compound index
      const count = await events
        .where("userId+category")
        .between([1, "login"], [1, "login"], true, true)
        .count();
      expect(count).toBe(2);
    });
  });
});
