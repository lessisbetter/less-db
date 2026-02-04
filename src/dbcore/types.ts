/**
 * DBCore types - the internal abstraction layer over IndexedDB.
 *
 * This layer provides a clean interface for all database operations,
 * enabling middleware to intercept and modify operations.
 */

import type { TableSchema } from '../schema-parser.js';

/**
 * Transaction mode.
 */
export type TransactionMode = 'readonly' | 'readwrite';

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
  type: DBCoreRangeType;
  /** Lower bound (for Range) or the value (for Equal/NotEqual) */
  lower?: unknown;
  /** Upper bound (for Range) */
  upper?: unknown;
  /** Include lower bound in range */
  lowerOpen?: boolean;
  /** Include upper bound in range */
  upperOpen?: boolean;
  /** Set of values (for Any) */
  values?: unknown[];
}

/**
 * Query request specification.
 */
export interface DBCoreQueryRequest {
  /** Index to query (empty string for primary key) */
  index: string;
  /** Key range to match */
  range: DBCoreKeyRange;
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
 * Query response.
 */
export interface DBCoreQueryResponse {
  /** Matching values */
  values: unknown[];
  /** Matching primary keys */
  keys: unknown[];
}

/**
 * Cursor for iterating over results.
 */
export interface DBCoreCursor {
  /** Current key */
  key: unknown;
  /** Current primary key */
  primaryKey: unknown;
  /** Current value */
  value: unknown;
  /** Move to next item */
  continue(): void;
  /** Move forward by count items */
  advance(count: number): void;
  /** Stop iteration */
  stop(): void;
}

/**
 * Cursor callback.
 */
export type DBCoreCursorCallback = (cursor: DBCoreCursor | null) => void;

/**
 * Mutation request for add/put/delete operations.
 */
export interface DBCoreMutateRequest {
  /** Type of mutation */
  type: 'add' | 'put' | 'delete' | 'deleteRange';
  /** Values to add/put (for add/put) */
  values?: unknown[];
  /** Keys for the values (for outbound keys) */
  keys?: unknown[];
  /** Range to delete (for deleteRange) */
  range?: DBCoreKeyRange;
}

/**
 * Mutation response.
 */
export interface DBCoreMutateResponse {
  /** Number of records affected */
  numFailures: number;
  /** Keys of added/updated records */
  results?: unknown[];
  /** Failures with their keys */
  failures?: Record<number, Error>;
  /** Last inserted key (for auto-increment) */
  lastKey?: unknown;
}

/**
 * Transaction interface.
 */
export interface DBCoreTransaction {
  /** Transaction mode */
  mode: TransactionMode;
  /** Tables in this transaction */
  tables: string[];
  /** Underlying IDB transaction */
  idbTransaction: IDBTransaction;
  /** Abort the transaction */
  abort(): void;
}

/**
 * Table interface for low-level operations.
 */
export interface DBCoreTable {
  /** Table name */
  name: string;
  /** Table schema */
  schema: TableSchema;

  /** Get a single value by key */
  get(trans: DBCoreTransaction, key: unknown): Promise<unknown>;

  /** Get multiple values by keys */
  getMany(trans: DBCoreTransaction, keys: unknown[]): Promise<unknown[]>;

  /** Query the table */
  query(trans: DBCoreTransaction, request: DBCoreQueryRequest): Promise<DBCoreQueryResponse>;

  /** Open a cursor for iteration */
  openCursor(
    trans: DBCoreTransaction,
    request: DBCoreQueryRequest,
    callback: DBCoreCursorCallback
  ): Promise<void>;

  /** Count matching records */
  count(trans: DBCoreTransaction, range?: DBCoreKeyRange): Promise<number>;

  /** Mutate records (add/put/delete) */
  mutate(trans: DBCoreTransaction, request: DBCoreMutateRequest): Promise<DBCoreMutateResponse>;
}

/**
 * Core database interface.
 */
export interface DBCore {
  /** All tables */
  tables: Map<string, DBCoreTable>;

  /** Get a table by name */
  table(name: string): DBCoreTable;

  /** Create a transaction */
  transaction(tables: string[], mode: TransactionMode): DBCoreTransaction;
}

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
  upperOpen = false
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
