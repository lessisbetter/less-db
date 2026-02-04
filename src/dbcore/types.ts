/**
 * DBCore types - the internal abstraction layer over IndexedDB.
 *
 * This layer provides a clean interface for all database operations,
 * enabling middleware to intercept and modify operations.
 *
 * API design follows Dexie.js for compatibility with Dexie middleware.
 */

import type { TableSchema } from "../schema-parser.js";

/**
 * Transaction mode.
 */
export type TransactionMode = "readonly" | "readwrite";

/**
 * Key range types for queries.
 */
export enum DBCoreRangeType {
  /** Match a single key: key === value */
  Equal = 1,
  /** Match keys in a range: lower <= key <= upper */
  Range = 2,
  /** Match any of a set of keys */
  Any = 3,
  /** Match keys not equal to value */
  NotEqual = 4,
}

/**
 * Key range specification.
 */
export interface DBCoreKeyRange {
  readonly type: DBCoreRangeType;
  /** Lower bound (for Range) or the value (for Equal/NotEqual) */
  readonly lower?: unknown;
  /** Upper bound (for Range) */
  readonly upper?: unknown;
  /** Include lower bound in range */
  readonly lowerOpen?: boolean;
  /** Include upper bound in range */
  readonly upperOpen?: boolean;
  /** Set of values (for Any) */
  readonly values?: unknown[];
}

/**
 * Transaction interface.
 * Middleware can attach custom properties via bracket notation.
 */
export interface DBCoreTransaction {
  /** Abort the transaction */
  abort(): void;
}

/**
 * Internal transaction type with specific properties.
 * This extends DBCoreTransaction with properties our implementation uses.
 */
export interface InternalTransaction extends DBCoreTransaction {
  /** Transaction mode */
  mode: TransactionMode;
  /** Tables in this transaction */
  tables: string[];
  /** Underlying IDB transaction */
  idbTransaction: IDBTransaction;
  /** Allow custom properties for middleware (e.g., __syncOrigin) */
  [key: string]: unknown;
}

/**
 * Index specification for queries.
 */
export interface DBCoreIndex {
  /** Index name, or empty string for primary key */
  readonly name: string;
  /** Key path */
  readonly keyPath: string | null;
  /** Whether this is the primary key */
  readonly isPrimaryKey?: boolean;
  /** Whether keys are auto-generated */
  readonly autoIncrement?: boolean;
  /** Whether index values must be unique */
  readonly unique?: boolean;
}

/**
 * Query specification (index + range).
 */
export interface DBCoreQuery {
  /** Index to query */
  index: DBCoreIndex;
  /** Key range to match */
  range: DBCoreKeyRange;
}

// ============================================
// Request types - all include trans
// ============================================

/**
 * Get single item request.
 */
export interface DBCoreGetRequest {
  trans: DBCoreTransaction;
  key: unknown;
}

/**
 * Get multiple items request.
 */
export interface DBCoreGetManyRequest {
  trans: DBCoreTransaction;
  keys: unknown[];
}

/**
 * Query request.
 *
 * The `values` flag controls what is returned in `result`:
 * - values: true (default) → result contains values (uses getAll)
 * - values: false → result contains primary keys (uses getAllKeys)
 */
export interface DBCoreQueryRequest {
  trans: DBCoreTransaction;
  /** Query specification (index + range) */
  query: DBCoreQuery;
  /** Whether to return values (true) or primary keys (false). Default: true */
  values?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Number of results to skip */
  offset?: number;
  /** Query direction */
  reverse?: boolean;
  /** Only return unique keys (for non-unique indexes) */
  unique?: boolean;
}

/**
 * Open cursor request.
 */
export interface DBCoreOpenCursorRequest {
  trans: DBCoreTransaction;
  /** Query specification (index + range) */
  query: DBCoreQuery;
  /** Whether to return values (default: true) */
  values?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Number of results to skip */
  offset?: number;
  /** Query direction */
  reverse?: boolean;
  /** Only return unique keys */
  unique?: boolean;
}

/**
 * Count request.
 */
export interface DBCoreCountRequest {
  trans: DBCoreTransaction;
  query: DBCoreQuery;
}

/**
 * Query response.
 *
 * The `result` array contains either values or primary keys,
 * depending on the `values` flag in the request.
 */
export interface DBCoreQueryResponse {
  /** Matching values (if values=true) or primary keys (if values=false) */
  result: unknown[];
}

/**
 * Cursor for iterating over results.
 */
export interface DBCoreCursor {
  /** Transaction this cursor belongs to */
  readonly trans: DBCoreTransaction;
  /** Current index key */
  readonly key: unknown;
  /** Current primary key */
  readonly primaryKey: unknown;
  /** Current value */
  readonly value?: unknown;
  /** Whether iteration is complete */
  readonly done?: boolean;
  /** Move to next item, optionally jumping to a specific key */
  continue(key?: unknown): void;
  /** Move forward by count items */
  advance(count: number): void;
  /** Stop iteration */
  stop(value?: unknown): void;
  /** Fail with error */
  fail(error: Error): void;
}

// ============================================
// Mutation types
// ============================================

/**
 * Add request.
 */
export interface DBCoreAddRequest {
  type: "add";
  trans: DBCoreTransaction;
  values: readonly unknown[];
  keys?: unknown[];
}

/**
 * Put request.
 */
export interface DBCorePutRequest {
  type: "put";
  trans: DBCoreTransaction;
  values: readonly unknown[];
  keys?: unknown[];
  /** Criteria for targeted updates */
  criteria?: {
    index: string | null;
    range: DBCoreKeyRange;
  };
  /** Common changes for all items */
  changeSpec?: { [keyPath: string]: unknown };
}

/**
 * Delete request.
 */
export interface DBCoreDeleteRequest {
  type: "delete";
  trans: DBCoreTransaction;
  keys: unknown[];
  /** Criteria for targeted deletes */
  criteria?: {
    index: string | null;
    range: DBCoreKeyRange;
  };
}

/**
 * Delete range request.
 */
export interface DBCoreDeleteRangeRequest {
  type: "deleteRange";
  trans: DBCoreTransaction;
  range: DBCoreKeyRange;
}

/**
 * Union of all mutation request types.
 */
export type DBCoreMutateRequest =
  | DBCoreAddRequest
  | DBCorePutRequest
  | DBCoreDeleteRequest
  | DBCoreDeleteRangeRequest;

/**
 * Mutation response.
 */
export interface DBCoreMutateResponse {
  /** Number of failed operations */
  numFailures: number;
  /** Keys of added/updated records (for add/put) */
  results?: unknown[];
  /** Failures indexed by operation number */
  failures?: { [operationNumber: number]: Error };
  /** Last inserted key (for auto-increment) */
  lastResult?: unknown;
}

// ============================================
// Table schema
// ============================================

/**
 * Table schema for DBCore.
 */
export interface DBCoreTableSchema {
  readonly name: string;
  readonly primaryKey: DBCoreIndex;
  readonly indexes: readonly DBCoreIndex[];
}

// ============================================
// Table interface
// ============================================

/**
 * Table interface for low-level operations.
 * All methods take a single request object containing the transaction.
 */
export interface DBCoreTable {
  /** Table name */
  readonly name: string;
  /** Table schema */
  readonly schema: DBCoreTableSchema;

  /** Get a single value by key */
  get(req: DBCoreGetRequest): Promise<unknown>;

  /** Get multiple values by keys */
  getMany(req: DBCoreGetManyRequest): Promise<unknown[]>;

  /** Query the table */
  query(req: DBCoreQueryRequest): Promise<DBCoreQueryResponse>;

  /** Open a cursor for iteration */
  openCursor(req: DBCoreOpenCursorRequest): Promise<DBCoreCursor | null>;

  /** Count matching records */
  count(req: DBCoreCountRequest): Promise<number>;

  /** Mutate records (add/put/delete) */
  mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse>;
}

// ============================================
// Database schema
// ============================================

/**
 * Database schema for DBCore.
 */
export interface DBCoreSchema {
  readonly name: string;
  readonly tables: readonly DBCoreTableSchema[];
}

// ============================================
// Core interface
// ============================================

/**
 * Core database interface.
 */
export interface DBCore {
  /** Stack identifier for middleware */
  readonly stack: "dbcore";

  /** Database schema */
  readonly schema: DBCoreSchema;

  /** Get a table by name */
  table(name: string): DBCoreTable;

  /** Create a transaction */
  transaction(tables: string[], mode: TransactionMode): DBCoreTransaction;
}

// ============================================
// Helper functions
// ============================================

/**
 * Create an equal key range.
 */
export function keyRangeEqual(value: unknown): DBCoreKeyRange {
  return { type: DBCoreRangeType.Equal, lower: value };
}

/**
 * Create a range key range.
 */
export function keyRangeRange(
  lower: unknown,
  upper: unknown,
  lowerOpen = false,
  upperOpen = false,
): DBCoreKeyRange {
  return {
    type: DBCoreRangeType.Range,
    lower,
    upper,
    lowerOpen,
    upperOpen,
  };
}

/**
 * Create an "any of" key range.
 */
export function keyRangeAnyOf(values: unknown[]): DBCoreKeyRange {
  return { type: DBCoreRangeType.Any, values };
}

/**
 * Create a "none of" (not equal) key range.
 */
export function keyRangeNotEqual(value: unknown): DBCoreKeyRange {
  return { type: DBCoreRangeType.NotEqual, lower: value };
}

/**
 * Create a "greater than" key range.
 */
export function keyRangeAbove(value: unknown, open = true): DBCoreKeyRange {
  return {
    type: DBCoreRangeType.Range,
    lower: value,
    upper: undefined,
    lowerOpen: open,
    upperOpen: true,
  };
}

/**
 * Create a "less than" key range.
 */
export function keyRangeBelow(value: unknown, open = true): DBCoreKeyRange {
  return {
    type: DBCoreRangeType.Range,
    lower: undefined,
    upper: value,
    lowerOpen: true,
    upperOpen: open,
  };
}

/**
 * Create a full range (matches all keys).
 */
export function keyRangeAll(): DBCoreKeyRange {
  return {
    type: DBCoreRangeType.Range,
    lower: undefined,
    upper: undefined,
    lowerOpen: true,
    upperOpen: true,
  };
}

/**
 * Create a DBCoreIndex from a TableSchema primary key or index.
 */
export function toDBCoreIndex(
  name: string,
  keyPath: string | null,
  options?: { isPrimaryKey?: boolean; autoIncrement?: boolean; unique?: boolean },
): DBCoreIndex {
  return {
    name,
    keyPath,
    isPrimaryKey: options?.isPrimaryKey,
    autoIncrement: options?.autoIncrement,
    unique: options?.unique ?? options?.isPrimaryKey,
  };
}

/**
 * Create a DBCoreTableSchema from a TableSchema.
 */
export function toDBCoreTableSchema(name: string, schema: TableSchema): DBCoreTableSchema {
  const primaryKey = toDBCoreIndex(schema.primaryKey.name, schema.primaryKey.keyPath, {
    isPrimaryKey: true,
    autoIncrement: schema.primaryKey.auto,
    unique: true,
  });

  const indexes = schema.indexes.map((idx) =>
    toDBCoreIndex(idx.name, idx.keyPath, { unique: idx.unique }),
  );

  return { name, primaryKey, indexes };
}

/**
 * Create a DBCoreQuery for primary key lookup.
 */
export function primaryKeyQuery(schema: DBCoreTableSchema, range: DBCoreKeyRange): DBCoreQuery {
  return {
    index: schema.primaryKey,
    range,
  };
}

/**
 * Create a DBCoreQuery for index lookup.
 */
export function indexQuery(
  schema: DBCoreTableSchema,
  indexName: string,
  range: DBCoreKeyRange,
): DBCoreQuery {
  const index = schema.indexes.find((idx) => idx.name === indexName);
  if (!index) {
    // Fall back to primary key if index not found
    return primaryKeyQuery(schema, range);
  }
  return { index, range };
}

/**
 * Extract primary key from a value using the schema's keyPath.
 * Returns undefined for outbound keys (keyPath is null).
 */
export function extractPrimaryKey(value: unknown, schema: DBCoreTableSchema): unknown {
  const keyPath = schema.primaryKey.keyPath;
  if (keyPath === null) {
    // Outbound key - can't extract from value
    return undefined;
  }
  return (value as Record<string, unknown>)[keyPath];
}

/**
 * Extract primary keys from an array of values.
 */
export function extractPrimaryKeys(values: unknown[], schema: DBCoreTableSchema): unknown[] {
  const keyPath = schema.primaryKey.keyPath;
  if (keyPath === null) {
    // Outbound keys - can't extract
    return values.map(() => undefined);
  }
  return values.map((v) => (v as Record<string, unknown>)[keyPath]);
}
