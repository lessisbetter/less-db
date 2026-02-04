/**
 * Schema parser for Dexie-style schema strings.
 *
 * Format: '[primaryKey], [index1], [index2], ...'
 *
 * Primary key modifiers:
 *   ++       Auto-increment
 *   &        Unique (also valid for indexes)
 *
 * Index types:
 *   field           - Single field index
 *   [field1+field2] - Compound index on multiple fields
 *
 * Examples:
 *   '++id'                    - Auto-increment id field
 *   '++'                      - Auto-increment, key not in object (outbound)
 *   'id'                      - Explicit id field
 *   '++id, name'              - Primary key + indexed name field
 *   '++id, &email'            - Primary key + unique email index
 *   '++id, [firstName+lastName]' - Primary key + compound index
 *   '++id, &[email+domain]'   - Primary key + unique compound index
 */

import { SchemaError } from "./errors/index.js";

/**
 * Specification for a single index or primary key.
 */
export interface IndexSpec {
  /** The name of the index (e.g., "email" or "firstName+lastName") */
  name: string;
  /** The key path - property name(s) to index. Array for compound indexes. */
  keyPath: string | string[] | null;
  /** Whether this is the primary key */
  isPrimaryKey: boolean;
  /** Whether the key auto-increments */
  auto: boolean;
  /** Whether the index enforces uniqueness */
  unique: boolean;
  /** Whether the key is stored outside the object (outbound) */
  outbound: boolean;
  /** Whether this is a compound (multi-field) index */
  compound: boolean;
}

/**
 * Full schema specification for a table.
 */
export interface TableSchema {
  /** Table name */
  name: string;
  /** Primary key specification */
  primaryKey: IndexSpec;
  /** Secondary indexes */
  indexes: IndexSpec[];
}

/**
 * Database schema - maps table names to their schemas.
 */
export type DatabaseSchema = Record<string, TableSchema>;

/**
 * Parse a single index/key specification.
 *
 * Examples:
 *   '++id' -> auto-increment primary key
 *   '&email' -> unique index
 *   'name' -> regular index
 *   '++' -> outbound auto-increment
 *   '[firstName+lastName]' -> compound index
 *   '&[email+domain]' -> unique compound index
 */
function parseIndexSpec(spec: string, isPrimaryKey: boolean): IndexSpec {
  let name = spec.trim();
  let auto = false;
  let unique = false;
  let outbound = false;
  let compound = false;
  let keyPath: string | string[] | null = null;

  // Check for auto-increment prefix
  if (name.startsWith("++")) {
    auto = true;
    name = name.slice(2);
  }

  // Check for unique prefix
  if (name.startsWith("&")) {
    unique = true;
    name = name.slice(1);
  }

  // Check for compound index syntax: [field1+field2+...]
  if (name.startsWith("[") && name.endsWith("]")) {
    compound = true;
    const inner = name.slice(1, -1).trim();

    if (!inner) {
      throw new SchemaError("Empty compound index definition");
    }

    // Split by + and trim each field
    const fields = inner.split("+").map((f) => f.trim());

    if (fields.length < 2) {
      throw new SchemaError(`Compound index must have at least 2 fields, got: "${inner}"`);
    }

    // Validate field names (no empty fields, no special chars except underscore)
    for (const field of fields) {
      if (!field) {
        throw new SchemaError(`Empty field name in compound index: "${inner}"`);
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        throw new SchemaError(`Invalid field name in compound index: "${field}"`);
      }
    }

    // Name is fields joined by +, keyPath is the array
    name = fields.join("+");
    keyPath = fields;
  } else if (name === "") {
    // If name is empty after removing prefixes, it's an outbound key
    if (!isPrimaryKey) {
      throw new SchemaError("Empty index name is only valid for primary key");
    }
    outbound = true;
    keyPath = null;
  } else {
    // Simple single-field index
    keyPath = name;
  }

  // Primary keys are implicitly unique
  if (isPrimaryKey) {
    unique = true;
  }

  return {
    name: name || "",
    keyPath,
    isPrimaryKey,
    auto,
    unique,
    outbound,
    compound,
  };
}

/**
 * Parse a table schema string.
 *
 * @param tableName - The name of the table
 * @param schemaString - The schema string (e.g., '++id, name, age')
 * @returns Parsed table schema
 */
export function parseTableSchema(tableName: string, schemaString: string): TableSchema {
  const parts = schemaString.split(",").map((s) => s.trim());

  const [primaryKeySpec, ...indexSpecs] = parts;

  if (!primaryKeySpec || primaryKeySpec === "") {
    throw new SchemaError(`Empty schema for table "${tableName}"`);
  }

  // First part is always the primary key
  const primaryKey = parseIndexSpec(primaryKeySpec, true);

  // Rest are secondary indexes
  const indexes: IndexSpec[] = [];
  for (const part of indexSpecs) {
    if (part === "") continue;
    indexes.push(parseIndexSpec(part, false));
  }

  return {
    name: tableName,
    primaryKey,
    indexes,
  };
}

/**
 * Parse a full stores definition object.
 *
 * @param stores - Object mapping table names to schema strings
 * @returns Parsed database schema
 */
export function parseStores(stores: Record<string, string>): DatabaseSchema {
  const schema: DatabaseSchema = {};

  for (const [tableName, schemaString] of Object.entries(stores)) {
    schema[tableName] = parseTableSchema(tableName, schemaString);
  }

  return schema;
}

/**
 * Get the key path for extracting primary keys from objects.
 */
export function getKeyPath(schema: TableSchema): string | string[] | null {
  return schema.primaryKey.keyPath;
}

/**
 * Compare two keyPaths for equality (handles both string and array).
 */
function keyPathsEqual(a: string | string[] | null, b: string | string[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  // Both are arrays
  if (a.length !== b.length) return false;
  return a.every((val, i) => val === b[i]);
}

/**
 * Check if a table uses auto-increment keys.
 */
export function isAutoIncrement(schema: TableSchema): boolean {
  return schema.primaryKey.auto;
}

/**
 * Check if a table uses outbound (external) keys.
 */
export function isOutbound(schema: TableSchema): boolean {
  return schema.primaryKey.outbound;
}

/**
 * Get all index names for a table (excluding primary key).
 */
export function getIndexNames(schema: TableSchema): string[] {
  return schema.indexes.map((idx) => idx.name);
}

/**
 * Get index spec by name.
 */
export function getIndex(schema: TableSchema, name: string): IndexSpec | undefined {
  if (schema.primaryKey.name === name) {
    return schema.primaryKey;
  }
  return schema.indexes.find((idx) => idx.name === name);
}

/**
 * Validate that two schemas are compatible for upgrade.
 * Returns list of changes needed.
 */
export interface SchemaChange {
  type: "add-table" | "delete-table" | "add-index" | "delete-index" | "change-primary-key";
  tableName: string;
  indexName?: string;
  spec?: IndexSpec;
}

export function diffSchemas(oldSchema: DatabaseSchema, newSchema: DatabaseSchema): SchemaChange[] {
  const changes: SchemaChange[] = [];

  // Check for deleted tables
  for (const tableName of Object.keys(oldSchema)) {
    if (!(tableName in newSchema)) {
      changes.push({ type: "delete-table", tableName });
    }
  }

  // Check for new tables and index changes
  for (const [tableName, newTable] of Object.entries(newSchema)) {
    const oldTable = oldSchema[tableName];

    if (!oldTable) {
      changes.push({ type: "add-table", tableName });
      continue;
    }

    // Check primary key changes (not allowed - requires recreate)
    if (
      !keyPathsEqual(oldTable.primaryKey.keyPath, newTable.primaryKey.keyPath) ||
      oldTable.primaryKey.auto !== newTable.primaryKey.auto
    ) {
      changes.push({ type: "change-primary-key", tableName });
    }

    // Check for deleted indexes
    for (const oldIdx of oldTable.indexes) {
      const newIdx = newTable.indexes.find((i) => i.name === oldIdx.name);
      if (!newIdx) {
        changes.push({ type: "delete-index", tableName, indexName: oldIdx.name });
      }
    }

    // Check for new indexes
    for (const newIdx of newTable.indexes) {
      const oldIdx = oldTable.indexes.find((i) => i.name === newIdx.name);
      if (!oldIdx) {
        changes.push({
          type: "add-index",
          tableName,
          indexName: newIdx.name,
          spec: newIdx,
        });
      }
    }
  }

  return changes;
}
