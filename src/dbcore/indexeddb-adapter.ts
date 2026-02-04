/**
 * IndexedDB adapter - implements DBCore interface using native IndexedDB.
 *
 * All methods follow Dexie's API pattern where requests contain the transaction.
 */

import type { TableSchema } from "../schema-parser.js";
import { mapError, InvalidTableError } from "../errors/index.js";
import {
  getIDBKeyRange,
  safariMultiStoreFix,
  hasWorkingGetAll,
  fixUndefinedKey,
  compareKeys,
  supportsDurability,
  supportsCommit,
} from "../compat/index.js";
import {
  type DBCore,
  type DBCoreTable,
  type DBCoreTransaction,
  type DBCoreSchema,
  type DBCoreTableSchema,
  type DBCoreQuery,
  type DBCoreGetRequest,
  type DBCoreGetManyRequest,
  type DBCoreQueryRequest,
  type DBCoreQueryResponse,
  type DBCoreOpenCursorRequest,
  type DBCoreCountRequest,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreKeyRange,
  type DBCoreCursor,
  type InternalTransaction,
  type TransactionMode,
  type TransactionOptions,
  type CursorAlgorithm,
  DBCoreRangeType,
  toDBCoreTableSchema,
} from "./types.js";

/**
 * Convert our key range to IDBKeyRange.
 */
function toIDBKeyRange(range: DBCoreKeyRange): IDBKeyRange | undefined {
  const IDBKeyRange = getIDBKeyRange();
  if (!IDBKeyRange) return undefined;

  switch (range.type) {
    case DBCoreRangeType.Equal:
      return IDBKeyRange.only(range.lower);

    case DBCoreRangeType.Range: {
      const hasLower = range.lower !== undefined;
      const hasUpper = range.upper !== undefined;

      if (hasLower && hasUpper) {
        return IDBKeyRange.bound(range.lower, range.upper, range.lowerOpen, range.upperOpen);
      } else if (hasLower) {
        return IDBKeyRange.lowerBound(range.lower, range.lowerOpen);
      } else if (hasUpper) {
        return IDBKeyRange.upperBound(range.upper, range.upperOpen);
      }
      return undefined; // Full range
    }

    case DBCoreRangeType.Any:
      // Can't represent with single IDBKeyRange - handled specially
      return undefined;

    case DBCoreRangeType.NotEqual:
      // Can't represent with IDBKeyRange - handled with filter
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Wrap an IDB request in a promise.
 */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(mapError(request.error));
  });
}

/**
 * Get the IDBTransaction from a DBCoreTransaction.
 * Casts to InternalTransaction since our implementation always provides these properties.
 */
function getIDBTransaction(trans: DBCoreTransaction): IDBTransaction {
  return (trans as InternalTransaction).idbTransaction;
}

/**
 * IndexedDB implementation of DBCoreTransaction.
 * Implements InternalTransaction which extends DBCoreTransaction with
 * mode, tables, and idbTransaction properties.
 */
class IDBCoreTransaction implements InternalTransaction {
  readonly mode: TransactionMode;
  readonly tables: string[];
  readonly idbTransaction: IDBTransaction;
  [key: string]: unknown;

  constructor(idbTransaction: IDBTransaction, tables: string[], mode: TransactionMode) {
    this.idbTransaction = idbTransaction;
    this.tables = tables;
    this.mode = mode;
  }

  abort(): void {
    this.idbTransaction.abort();
  }

  commit(): void {
    // commit() is supported in Chrome 76+, Firefox 74+, Safari 15+
    if (supportsCommit()) {
      this.idbTransaction.commit();
    }
    // If not supported, transaction will auto-commit when inactive
  }
}

/**
 * IndexedDB implementation of DBCoreTable.
 */
class IDBCoreTable implements DBCoreTable {
  readonly name: string;
  readonly schema: DBCoreTableSchema;
  private tableSchema: TableSchema;
  private useGetAll: boolean;

  constructor(name: string, tableSchema: TableSchema, dbCoreSchema: DBCoreTableSchema) {
    this.name = name;
    this.tableSchema = tableSchema;
    this.schema = dbCoreSchema;
    this.useGetAll = hasWorkingGetAll();
  }

  private getStore(trans: DBCoreTransaction): IDBObjectStore {
    return getIDBTransaction(trans).objectStore(this.name);
  }

  private getIndex(store: IDBObjectStore, query: DBCoreQuery): IDBObjectStore | IDBIndex {
    if (query.index.isPrimaryKey || !query.index.name) {
      return store;
    }
    return store.index(query.index.name);
  }

  async get(req: DBCoreGetRequest): Promise<unknown> {
    const store = this.getStore(req.trans);
    return promisifyRequest(store.get(req.key as IDBValidKey));
  }

  async getMany(req: DBCoreGetManyRequest): Promise<unknown[]> {
    const store = this.getStore(req.trans);
    const keys = req.keys;
    const length = keys.length;

    if (length === 0) return [];

    return new Promise((resolve, reject) => {
      const result = new Array(length);
      let pendingCount = 0;
      let completedCount = 0;

      const successHandler = (event: Event) => {
        const target = event.target as IDBRequest & { _pos: number };
        result[target._pos] = target.result;
        if (++completedCount === pendingCount) resolve(result);
      };

      const errorHandler = (event: Event) => {
        reject(mapError((event.target as IDBRequest).error));
      };

      for (let i = 0; i < length; i++) {
        const key = keys[i];
        if (key != null) {
          const idbReq = store.get(key as IDBValidKey) as IDBRequest & { _pos: number };
          idbReq._pos = i;
          idbReq.onsuccess = successHandler;
          idbReq.onerror = errorHandler;
          pendingCount++;
        }
      }

      if (pendingCount === 0) resolve(result);
    });
  }

  async query(req: DBCoreQueryRequest): Promise<DBCoreQueryResponse> {
    const store = this.getStore(req.trans);
    const source = this.getIndex(store, req.query);

    // Handle "any of" queries by doing multiple queries in parallel
    if (req.query.range.type === DBCoreRangeType.Any && req.query.range.values) {
      return this.queryAnyOf(source, req);
    }

    // Handle "not equal" with cursor and filter
    if (req.query.range.type === DBCoreRangeType.NotEqual) {
      return this.queryNotEqual(source, req);
    }

    // If cursorAlgorithm is provided, use cursor-based iteration with jumping
    if (req.cursorAlgorithm) {
      return this.queryWithCursorAlgorithm(source, req);
    }

    // Standard query
    return this.querySimple(source, req);
  }

  /**
   * Handle "any of" queries by issuing multiple queries in parallel.
   */
  private async queryAnyOf(
    source: IDBObjectStore | IDBIndex,
    req: DBCoreQueryRequest,
  ): Promise<DBCoreQueryResponse> {
    // Handle limit=0 case - return empty result immediately
    if (req.limit === 0) {
      return { result: [] };
    }

    const IDBKeyRange = getIDBKeyRange();
    if (!IDBKeyRange) {
      return { result: [] };
    }

    const values = req.query.range.values!;
    const wantValues = req.values !== false;
    // Use 'nextunique'/'prevunique' directions when unique=true for native deduplication
    const direction: IDBCursorDirection = req.unique
      ? req.reverse
        ? "prevunique"
        : "nextunique"
      : req.reverse
        ? "prev"
        : "next";
    const result: unknown[] = [];

    if (this.useGetAll && !req.offset) {
      const promises = values.map((value) => {
        const singleRange = IDBKeyRange.only(value);
        return wantValues
          ? promisifyRequest(source.getAll(singleRange, req.limit))
          : promisifyRequest(source.getAllKeys(singleRange, req.limit));
      });

      const allResults = await Promise.all(promises);
      for (const items of allResults) {
        result.push(...items);
        if (req.limit !== undefined && result.length >= req.limit) {
          break;
        }
      }
    } else {
      // Cursor-based queries must be sequential
      for (const value of values) {
        const singleRange = IDBKeyRange.only(value);
        await this.cursorQuery(source, singleRange, direction, req, result, wantValues);
        if (req.limit !== undefined && result.length >= req.limit) {
          break;
        }
      }
    }

    return { result: req.limit !== undefined ? result.slice(0, req.limit) : result };
  }

  /**
   * Handle "not equal" queries with cursor and filter.
   */
  private async queryNotEqual(
    source: IDBObjectStore | IDBIndex,
    req: DBCoreQueryRequest,
  ): Promise<DBCoreQueryResponse> {
    // Handle limit=0 case - return empty result immediately
    if (req.limit === 0) {
      return { result: [] };
    }

    const result: unknown[] = [];
    // Use 'nextunique'/'prevunique' directions when unique=true for native deduplication
    const direction: IDBCursorDirection = req.unique
      ? req.reverse
        ? "prevunique"
        : "nextunique"
      : req.reverse
        ? "prev"
        : "next";
    const wantValues = req.values !== false;

    await this.cursorQuery(
      source,
      undefined,
      direction,
      req,
      result,
      wantValues,
      (_value, _primaryKey, indexKey) => {
        return compareKeys(indexKey, req.query.range.lower) !== 0;
      },
    );

    return { result };
  }

  /**
   * Handle queries with cursor algorithm for optimized iteration with jumping.
   */
  private async queryWithCursorAlgorithm(
    source: IDBObjectStore | IDBIndex,
    req: DBCoreQueryRequest,
  ): Promise<DBCoreQueryResponse> {
    // Handle limit=0 case - return empty result immediately
    if (req.limit === 0) {
      return { result: [] };
    }

    const result: unknown[] = [];
    const idbRange = toIDBKeyRange(req.query.range);
    const direction: IDBCursorDirection = req.reverse ? "prev" : "next";
    const wantValues = req.values !== false;

    await this.cursorQueryWithAlgorithm(
      source,
      idbRange,
      direction,
      req,
      result,
      wantValues,
      req.cursorAlgorithm!,
    );

    return { result };
  }

  /**
   * Standard query - uses getAll/getAllKeys when available, falls back to cursor.
   */
  private async querySimple(
    source: IDBObjectStore | IDBIndex,
    req: DBCoreQueryRequest,
  ): Promise<DBCoreQueryResponse> {
    // Handle limit=0 case - return empty result immediately
    if (req.limit === 0) {
      return { result: [] };
    }

    const idbRange = toIDBKeyRange(req.query.range);
    const wantValues = req.values !== false;

    // Use getAll/getAllKeys when available and applicable
    if (this.useGetAll && !req.offset && !req.unique && !req.reverse) {
      const items = wantValues
        ? await promisifyRequest(source.getAll(idbRange, req.limit))
        : await promisifyRequest(source.getAllKeys(idbRange, req.limit));
      return { result: items };
    }

    // Fall back to cursor
    const result: unknown[] = [];
    // Use 'nextunique'/'prevunique' directions when unique=true for native deduplication
    const direction: IDBCursorDirection = req.unique
      ? req.reverse
        ? "prevunique"
        : "nextunique"
      : req.reverse
        ? "prev"
        : "next";
    await this.cursorQuery(source, idbRange, direction, req, result, wantValues);
    return { result };
  }

  private cursorQuery(
    source: IDBObjectStore | IDBIndex,
    range: IDBKeyRange | undefined,
    direction: IDBCursorDirection,
    req: DBCoreQueryRequest | DBCoreOpenCursorRequest,
    result: unknown[],
    wantValues: boolean,
    filter?: (value: unknown, primaryKey: unknown, indexKey: unknown) => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use openKeyCursor when we don't need values and there's no filter
      // openKeyCursor avoids loading record data from disk, improving performance
      const needsValues = wantValues || filter !== undefined;
      const cursorRequest = needsValues
        ? source.openCursor(range, direction)
        : source.openKeyCursor(range, direction);
      let skipped = 0;
      let collected = 0;
      const limit = req.limit ?? Infinity;
      const offset = req.offset ?? 0;
      let lastKey: unknown;

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor) {
          resolve();
          return;
        }

        // Handle unique filter
        if (req.unique && cursor.key === lastKey) {
          cursor.continue();
          return;
        }
        lastKey = cursor.key;

        // Apply custom filter
        // Note: filter is only set when needsValues is true, so cursor is IDBCursorWithValue
        if (
          filter &&
          !filter((cursor as IDBCursorWithValue).value, cursor.primaryKey, cursor.key)
        ) {
          cursor.continue();
          return;
        }

        // Handle offset
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        // Collect result (value or primaryKey depending on wantValues)
        // Note: when wantValues is true, cursor is IDBCursorWithValue
        result.push(wantValues ? (cursor as IDBCursorWithValue).value : cursor.primaryKey);
        collected++;

        // Check limit
        if (collected >= limit) {
          resolve();
          return;
        }

        cursor.continue();
      };

      cursorRequest.onerror = () => reject(mapError(cursorRequest.error));
    });
  }

  /**
   * Cursor query with algorithm-based iteration and cursor jumping.
   * The algorithm can return:
   * - true: include this record
   * - false: skip this record (continue to next)
   * - string: jump cursor to this key
   * - null: stop iteration
   */
  private cursorQueryWithAlgorithm(
    source: IDBObjectStore | IDBIndex,
    range: IDBKeyRange | undefined,
    direction: IDBCursorDirection,
    req: DBCoreQueryRequest,
    result: unknown[],
    wantValues: boolean,
    algorithm: CursorAlgorithm,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cursorRequest = source.openCursor(range, direction);
      let skipped = 0;
      let collected = 0;
      const limit = req.limit ?? Infinity;
      const offset = req.offset ?? 0;

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor) {
          resolve();
          return;
        }

        // Run the algorithm
        const algorithmResult = algorithm(cursor.key, cursor.value, cursor.primaryKey);

        // null means stop iteration
        if (algorithmResult === null) {
          resolve();
          return;
        }

        // string means jump to this key
        if (typeof algorithmResult === "string") {
          cursor.continue(algorithmResult as IDBValidKey);
          return;
        }

        // false means skip this record
        if (algorithmResult === false) {
          cursor.continue();
          return;
        }

        // true means include this record
        // Handle offset
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        // Collect result (value or primaryKey depending on wantValues)
        result.push(wantValues ? cursor.value : cursor.primaryKey);
        collected++;

        // Check limit
        if (collected >= limit) {
          resolve();
          return;
        }

        cursor.continue();
      };

      cursorRequest.onerror = () => reject(mapError(cursorRequest.error));
    });
  }

  async openCursor(req: DBCoreOpenCursorRequest): Promise<DBCoreCursor | null> {
    const store = this.getStore(req.trans);
    const source = this.getIndex(store, req.query);
    const idbRange = toIDBKeyRange(req.query.range);
    const direction: IDBCursorDirection = req.reverse ? "prev" : "next";
    const wantValues = req.values !== false;

    return new Promise((resolve, reject) => {
      // Use openKeyCursor when we don't need values
      // openKeyCursor avoids loading record data from disk, improving performance
      const cursorRequest = wantValues
        ? source.openCursor(idbRange, direction)
        : source.openKeyCursor(idbRange, direction);
      let skipped = 0;
      const offset = req.offset ?? 0;

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor) {
          resolve(null);
          return;
        }

        // Handle offset
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        // Create DBCoreCursor wrapper
        // Note: when wantValues is true, cursor is IDBCursorWithValue
        const dbCoreCursor: DBCoreCursor = {
          trans: req.trans,
          key: cursor.key,
          primaryKey: cursor.primaryKey,
          value: wantValues ? (cursor as IDBCursorWithValue).value : undefined,
          done: false,
          continue: (key?: unknown) => {
            if (key !== undefined) {
              cursor.continue(key as IDBValidKey);
            } else {
              cursor.continue();
            }
          },
          advance: (count: number) => cursor.advance(count),
          stop: () => resolve(null),
          fail: (error: Error) => reject(error),
        };

        resolve(dbCoreCursor);
      };

      cursorRequest.onerror = () => reject(mapError(cursorRequest.error));
    });
  }

  async count(req: DBCoreCountRequest): Promise<number> {
    const store = this.getStore(req.trans);
    const source = this.getIndex(store, req.query);
    const idbRange = toIDBKeyRange(req.query.range);
    return promisifyRequest(source.count(idbRange));
  }

  async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
    const store = this.getStore(req.trans);
    const keyPath = this.tableSchema.primaryKey.keyPath;

    switch (req.type) {
      case "add": {
        return new Promise((resolve, reject) => {
          const length = req.values.length;
          if (length === 0) {
            return resolve({ numFailures: 0, results: [], lastResult: undefined });
          }

          const results: unknown[] = new Array(length);
          const failures: Record<number, Error> = {};
          let numFailures = 0;
          let completedCount = 0;
          // Track the highest index that completed successfully for lastResult
          let lastSuccessIndex = -1;
          // For single-item operations, let errors abort the transaction naturally
          const preventAbort = length > 1;

          const handleComplete = () => {
            if (++completedCount === length) {
              resolve({
                numFailures,
                results,
                failures: numFailures > 0 ? failures : undefined,
                lastResult: lastSuccessIndex >= 0 ? results[lastSuccessIndex] : undefined,
              });
            }
          };

          for (let i = 0; i < length; i++) {
            let value = req.values[i];
            const key = keyPath ? undefined : req.keys?.[i];

            if (keyPath) {
              value = fixUndefinedKey(value as object, keyPath);
            }

            try {
              const idbReq = store.add(value, key as IDBValidKey | undefined);

              idbReq.onsuccess = () => {
                results[i] = idbReq.result;
                if (i > lastSuccessIndex) {
                  lastSuccessIndex = i;
                }
                handleComplete();
              };
              idbReq.onerror = (event) => {
                if (preventAbort) {
                  event.preventDefault(); // Prevent transaction abort for bulk operations
                  failures[i] = mapError(idbReq.error);
                  numFailures++;
                  results[i] = undefined;
                  handleComplete();
                } else {
                  // For single-item operations: reject and let transaction abort naturally
                  reject(mapError(idbReq.error));
                }
              };
            } catch (error) {
              // Synchronous errors (e.g., readonly transaction)
              if (preventAbort) {
                failures[i] = mapError(error);
                numFailures++;
                results[i] = undefined;
                handleComplete();
              } else {
                reject(mapError(error));
              }
            }
          }
        });
      }

      case "put": {
        return new Promise((resolve, reject) => {
          const length = req.values.length;
          if (length === 0) {
            return resolve({ numFailures: 0, results: [], lastResult: undefined });
          }

          const results: unknown[] = new Array(length);
          const failures: Record<number, Error> = {};
          let numFailures = 0;
          let completedCount = 0;
          // Track the highest index that completed successfully for lastResult
          let lastSuccessIndex = -1;
          // For single-item operations, let errors abort the transaction naturally
          const preventAbort = length > 1;

          const handleComplete = () => {
            if (++completedCount === length) {
              resolve({
                numFailures,
                results,
                failures: numFailures > 0 ? failures : undefined,
                lastResult: lastSuccessIndex >= 0 ? results[lastSuccessIndex] : undefined,
              });
            }
          };

          for (let i = 0; i < length; i++) {
            let value = req.values[i];
            const key = keyPath ? undefined : req.keys?.[i];

            if (keyPath) {
              value = fixUndefinedKey(value as object, keyPath);
            }

            try {
              const idbReq = store.put(value, key as IDBValidKey | undefined);

              idbReq.onsuccess = () => {
                results[i] = idbReq.result;
                if (i > lastSuccessIndex) {
                  lastSuccessIndex = i;
                }
                handleComplete();
              };
              idbReq.onerror = (event) => {
                if (preventAbort) {
                  event.preventDefault(); // Prevent transaction abort for bulk operations
                  failures[i] = mapError(idbReq.error);
                  numFailures++;
                  results[i] = undefined;
                  handleComplete();
                } else {
                  // For single-item operations: reject and let transaction abort naturally
                  reject(mapError(idbReq.error));
                }
              };
            } catch (error) {
              // Synchronous errors (e.g., readonly transaction)
              if (preventAbort) {
                failures[i] = mapError(error);
                numFailures++;
                results[i] = undefined;
                handleComplete();
              } else {
                reject(mapError(error));
              }
            }
          }
        });
      }

      case "delete": {
        return new Promise((resolve, reject) => {
          const length = req.keys.length;
          if (length === 0) {
            return resolve({ numFailures: 0 });
          }

          const failures: Record<number, Error> = {};
          let numFailures = 0;
          let completedCount = 0;
          // For single-item operations, let errors abort the transaction naturally
          const preventAbort = length > 1;

          const handleComplete = () => {
            if (++completedCount === length) {
              resolve({
                numFailures,
                failures: numFailures > 0 ? failures : undefined,
              });
            }
          };

          for (let i = 0; i < length; i++) {
            try {
              const idbReq = store.delete(req.keys[i] as IDBValidKey);

              idbReq.onsuccess = handleComplete;
              idbReq.onerror = (event) => {
                if (preventAbort) {
                  event.preventDefault(); // Prevent transaction abort for bulk operations
                  failures[i] = mapError(idbReq.error);
                  numFailures++;
                  handleComplete();
                } else {
                  // For single-item operations, reject and let transaction abort
                  reject(mapError(idbReq.error));
                }
              };
            } catch (error) {
              // Synchronous errors (e.g., readonly transaction)
              if (preventAbort) {
                failures[i] = mapError(error);
                numFailures++;
                handleComplete();
              } else {
                reject(mapError(error));
              }
            }
          }
        });
      }

      case "deleteRange": {
        try {
          const idbRange = toIDBKeyRange(req.range);
          if (idbRange) {
            await promisifyRequest(store.delete(idbRange));
          } else {
            await promisifyRequest(store.clear());
          }
          return { numFailures: 0 };
        } catch (error) {
          return {
            numFailures: 1,
            failures: { 0: mapError(error) },
          };
        }
      }

      default:
        return { numFailures: 0 };
    }
  }
}

/**
 * IndexedDB implementation of DBCore.
 */
export class IDBCore implements DBCore {
  readonly stack = "dbcore" as const;
  readonly schema: DBCoreSchema;
  private tableMap = new Map<string, DBCoreTable>();
  private idbDatabase: IDBDatabase;

  constructor(idbDatabase: IDBDatabase, schemas: Map<string, TableSchema>) {
    this.idbDatabase = idbDatabase;

    const tableSchemas: DBCoreTableSchema[] = [];
    for (const [name, tableSchema] of schemas) {
      const dbCoreSchema = toDBCoreTableSchema(name, tableSchema);
      tableSchemas.push(dbCoreSchema);
      this.tableMap.set(name, new IDBCoreTable(name, tableSchema, dbCoreSchema));
    }

    this.schema = {
      name: idbDatabase.name,
      tables: tableSchemas,
    };
  }

  table(name: string): DBCoreTable {
    const table = this.tableMap.get(name);
    if (!table) {
      throw new InvalidTableError(`Table "${name}" not found`);
    }
    return table;
  }

  transaction(
    tableNames: string[],
    mode: TransactionMode,
    options?: TransactionOptions,
  ): DBCoreTransaction {
    const storeNames = safariMultiStoreFix(tableNames);
    const idbMode = mode === "readwrite" ? "readwrite" : "readonly";

    let idbTrans: IDBTransaction;

    // Use durability option if supported and provided
    if (options?.durability && supportsDurability()) {
      idbTrans = this.idbDatabase.transaction(storeNames, idbMode, {
        durability: options.durability,
      });
    } else {
      idbTrans = this.idbDatabase.transaction(storeNames, idbMode);
    }

    return new IDBCoreTransaction(idbTrans, tableNames, mode);
  }
}

/**
 * Create IDBCore from an open IDBDatabase.
 */
export function createIDBCore(idbDatabase: IDBDatabase, schemas: Map<string, TableSchema>): DBCore {
  return new IDBCore(idbDatabase, schemas);
}
