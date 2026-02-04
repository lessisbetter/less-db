/**
 * LessDB - A minimal, extensible IndexedDB wrapper inspired by Dexie.js.
 *
 * @see https://github.com/dexie/Dexie.js - The library that inspired this project
 */

// Main database class
export { LessDB, createLessDB, type Middleware } from "./less-db.js";

// Table and query classes
export { Table } from "./table.js";
export { Collection } from "./collection.js";
export { WhereClause } from "./where-clause.js";

// Transaction
export { type Transaction, type TxMode, TransactionContext } from "./transaction.js";

// Schema
export {
  parseTableSchema,
  parseStores,
  type TableSchema,
  type IndexSpec,
  type DatabaseSchema,
} from "./schema-parser.js";

// Events and hooks
export {
  Event,
  Hook,
  EventEmitter,
  createTableHooks,
  type Listener,
  type Unsubscribe,
  type DatabaseChange,
  type DatabaseEvents,
  type TableHooks,
} from "./events/index.js";

// Errors
export {
  LessDBError,
  ConstraintError,
  NotFoundError,
  InvalidStateError,
  InvalidTableError,
  DataError,
  AbortError,
  MissingAPIError,
  SchemaError,
  BlockedError,
  VersionChangeError,
  mapError,
} from "./errors/index.js";

// DBCore (for advanced use / middleware)
export {
  type DBCore,
  type DBCoreTable,
  type DBCoreTransaction,
  type DBCoreQueryRequest,
  type DBCoreQueryResponse,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreKeyRange,
  type DBCoreCursor,
  type TransactionMode,
  DBCoreRangeType,
  keyRangeEqual,
  keyRangeRange,
  keyRangeAnyOf,
  keyRangeAbove,
  keyRangeBelow,
  createIDBCore,
} from "./dbcore/index.js";

// Compatibility utilities
export {
  getIndexedDB,
  getIDBKeyRange,
  compareKeys,
  getValueType,
  browserEnv,
} from "./compat/index.js";
