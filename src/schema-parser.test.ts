import { describe, it, expect, beforeEach } from "vitest";
import {
  parseTableSchema,
  parseStores,
  getKeyPath,
  isAutoIncrement,
  isOutbound,
  getIndexNames,
  getIndex,
  diffSchemas,
  type TableSchema,
  type DatabaseSchema,
} from "./schema-parser.js";
import { SchemaError } from "./errors/index.js";

describe("schema-parser", () => {
  describe("parseTableSchema", () => {
    describe("primary key parsing", () => {
      it("parses simple primary key", () => {
        const schema = parseTableSchema("users", "id");
        expect(schema.primaryKey.name).toBe("id");
        expect(schema.primaryKey.keyPath).toBe("id");
        expect(schema.primaryKey.auto).toBe(false);
        expect(schema.primaryKey.unique).toBe(true); // PKs are always unique
        expect(schema.primaryKey.outbound).toBe(false);
        expect(schema.primaryKey.isPrimaryKey).toBe(true);
      });

      it("parses auto-increment primary key", () => {
        const schema = parseTableSchema("users", "++id");
        expect(schema.primaryKey.name).toBe("id");
        expect(schema.primaryKey.keyPath).toBe("id");
        expect(schema.primaryKey.auto).toBe(true);
        expect(schema.primaryKey.outbound).toBe(false);
      });

      it("parses outbound auto-increment key", () => {
        const schema = parseTableSchema("logs", "++");
        expect(schema.primaryKey.name).toBe("");
        expect(schema.primaryKey.keyPath).toBe(null);
        expect(schema.primaryKey.auto).toBe(true);
        expect(schema.primaryKey.outbound).toBe(true);
      });

      it("parses unique primary key (& is redundant but valid)", () => {
        const schema = parseTableSchema("users", "&id");
        expect(schema.primaryKey.name).toBe("id");
        expect(schema.primaryKey.unique).toBe(true);
        expect(schema.primaryKey.auto).toBe(false);
      });

      it("parses auto-increment unique primary key", () => {
        const schema = parseTableSchema("users", "++&id");
        expect(schema.primaryKey.name).toBe("id");
        expect(schema.primaryKey.auto).toBe(true);
        expect(schema.primaryKey.unique).toBe(true);
      });
    });

    describe("secondary index parsing", () => {
      it("parses single secondary index", () => {
        const schema = parseTableSchema("users", "id, name");
        expect(schema.indexes).toHaveLength(1);
        expect(schema.indexes[0].name).toBe("name");
        expect(schema.indexes[0].keyPath).toBe("name");
        expect(schema.indexes[0].unique).toBe(false);
        expect(schema.indexes[0].isPrimaryKey).toBe(false);
      });

      it("parses multiple secondary indexes", () => {
        const schema = parseTableSchema("users", "++id, name, email, age");
        expect(schema.indexes).toHaveLength(3);
        expect(schema.indexes[0].name).toBe("name");
        expect(schema.indexes[1].name).toBe("email");
        expect(schema.indexes[2].name).toBe("age");
      });

      it("parses unique index", () => {
        const schema = parseTableSchema("users", "++id, &email");
        expect(schema.indexes).toHaveLength(1);
        expect(schema.indexes[0].name).toBe("email");
        expect(schema.indexes[0].unique).toBe(true);
      });

      it("parses mixed index types", () => {
        const schema = parseTableSchema("users", "++id, name, &email, age");
        expect(schema.indexes).toHaveLength(3);
        expect(schema.indexes[0].unique).toBe(false);
        expect(schema.indexes[1].unique).toBe(true);
        expect(schema.indexes[2].unique).toBe(false);
      });
    });

    describe("whitespace handling", () => {
      it("handles extra whitespace", () => {
        const schema = parseTableSchema("users", "  ++id  ,  name  ,  email  ");
        expect(schema.primaryKey.name).toBe("id");
        expect(schema.indexes).toHaveLength(2);
        expect(schema.indexes[0].name).toBe("name");
        expect(schema.indexes[1].name).toBe("email");
      });

      it("handles no whitespace", () => {
        const schema = parseTableSchema("users", "++id,name,email");
        expect(schema.primaryKey.name).toBe("id");
        expect(schema.indexes).toHaveLength(2);
      });
    });

    describe("error handling", () => {
      it("throws on empty schema", () => {
        expect(() => parseTableSchema("users", "")).toThrow(SchemaError);
      });

      it("throws on whitespace-only schema", () => {
        expect(() => parseTableSchema("users", "   ")).toThrow(SchemaError);
      });

      it("skips empty index names gracefully", () => {
        // Trailing comma is ok - empty segment is skipped
        const trailingComma = parseTableSchema("users", "id, ");
        expect(trailingComma.indexes).toHaveLength(0);

        // Empty middle segment is skipped
        const emptyMiddle = parseTableSchema("users", "id, , name");
        expect(emptyMiddle.indexes).toHaveLength(1);
        expect(emptyMiddle.indexes[0].name).toBe("name");
      });
    });

    describe("table name", () => {
      it("stores the table name", () => {
        const schema = parseTableSchema("myTable", "id");
        expect(schema.name).toBe("myTable");
      });
    });
  });

  describe("parseStores", () => {
    it("parses multiple tables", () => {
      const schema = parseStores({
        users: "++id, name, email",
        posts: "++id, userId, title",
        settings: "key",
      });

      expect(Object.keys(schema)).toHaveLength(3);
      expect(schema.users.primaryKey.name).toBe("id");
      expect(schema.posts.indexes).toHaveLength(2);
      expect(schema.settings.primaryKey.auto).toBe(false);
    });

    it("returns empty object for empty stores", () => {
      const schema = parseStores({});
      expect(Object.keys(schema)).toHaveLength(0);
    });
  });

  describe("helper functions", () => {
    let schema: TableSchema;

    beforeEach(() => {
      schema = parseTableSchema("users", "++id, name, &email");
    });

    describe("getKeyPath", () => {
      it("returns keyPath for inbound keys", () => {
        expect(getKeyPath(schema)).toBe("id");
      });

      it("returns null for outbound keys", () => {
        const outbound = parseTableSchema("logs", "++");
        expect(getKeyPath(outbound)).toBe(null);
      });
    });

    describe("isAutoIncrement", () => {
      it("returns true for auto-increment", () => {
        expect(isAutoIncrement(schema)).toBe(true);
      });

      it("returns false for non-auto-increment", () => {
        const manual = parseTableSchema("settings", "key");
        expect(isAutoIncrement(manual)).toBe(false);
      });
    });

    describe("isOutbound", () => {
      it("returns false for inbound keys", () => {
        expect(isOutbound(schema)).toBe(false);
      });

      it("returns true for outbound keys", () => {
        const outbound = parseTableSchema("logs", "++");
        expect(isOutbound(outbound)).toBe(true);
      });
    });

    describe("getIndexNames", () => {
      it("returns secondary index names", () => {
        expect(getIndexNames(schema)).toEqual(["name", "email"]);
      });

      it("returns empty array when no indexes", () => {
        const simple = parseTableSchema("settings", "key");
        expect(getIndexNames(simple)).toEqual([]);
      });
    });

    describe("getIndex", () => {
      it("returns primary key by name", () => {
        const idx = getIndex(schema, "id");
        expect(idx).toBeDefined();
        expect(idx?.isPrimaryKey).toBe(true);
      });

      it("returns secondary index by name", () => {
        const idx = getIndex(schema, "email");
        expect(idx).toBeDefined();
        expect(idx?.unique).toBe(true);
      });

      it("returns undefined for unknown index", () => {
        expect(getIndex(schema, "unknown")).toBeUndefined();
      });
    });
  });

  describe("diffSchemas", () => {
    it("detects added tables", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id"),
        posts: parseTableSchema("posts", "++id"),
      };

      const changes = diffSchemas(old, next);
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("add-table");
      expect(changes[0].tableName).toBe("posts");
    });

    it("detects deleted tables", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id"),
        posts: parseTableSchema("posts", "++id"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id"),
      };

      const changes = diffSchemas(old, next);
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("delete-table");
      expect(changes[0].tableName).toBe("posts");
    });

    it("detects added indexes", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id, name"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id, name, email"),
      };

      const changes = diffSchemas(old, next);
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("add-index");
      expect(changes[0].tableName).toBe("users");
      expect(changes[0].indexName).toBe("email");
    });

    it("detects deleted indexes", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id, name, email"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id, name"),
      };

      const changes = diffSchemas(old, next);
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("delete-index");
      expect(changes[0].indexName).toBe("email");
    });

    it("detects primary key changes", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "uuid"),
      };

      const changes = diffSchemas(old, next);
      expect(changes.some((c) => c.type === "change-primary-key")).toBe(true);
    });

    it("detects multiple changes", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id, name"),
        logs: parseTableSchema("logs", "++id"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id, email"),
        posts: parseTableSchema("posts", "++id"),
      };

      const changes = diffSchemas(old, next);

      // Should have: delete logs, add posts, delete name index, add email index
      expect(changes).toHaveLength(4);

      const types = changes.map((c) => c.type);
      expect(types).toContain("delete-table");
      expect(types).toContain("add-table");
      expect(types).toContain("delete-index");
      expect(types).toContain("add-index");
    });

    it("returns empty array for identical schemas", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id, name"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id, name"),
      };

      const changes = diffSchemas(old, next);
      expect(changes).toHaveLength(0);
    });

    it("handles both schemas empty", () => {
      const changes = diffSchemas({}, {});
      expect(changes).toHaveLength(0);
    });

    it("does not detect index property changes (same name)", () => {
      // Note: diffSchemas currently only compares index names, not properties.
      // Changing uniqueness on an existing index is not detected as a change.
      // This is a known limitation - full index property diffing would require
      // comparing unique, keyPath, etc. and generating modify-index changes.
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id, email"),
      };
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id, &email"),
      };

      const changes = diffSchemas(old, next);
      // No changes detected because index name 'email' exists in both
      expect(changes).toHaveLength(0);
    });

    it("handles adding table to empty schema", () => {
      const old: DatabaseSchema = {};
      const next: DatabaseSchema = {
        users: parseTableSchema("users", "++id"),
      };

      const changes = diffSchemas(old, next);
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("add-table");
    });

    it("handles removing all tables", () => {
      const old: DatabaseSchema = {
        users: parseTableSchema("users", "++id"),
      };
      const next: DatabaseSchema = {};

      const changes = diffSchemas(old, next);
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("delete-table");
    });
  });
});
