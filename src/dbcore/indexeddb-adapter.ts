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
    return Promise.all(req.keys.map((key) => promisifyRequest(store.get(key as IDBValidKey))));
  }

  async query(req: DBCoreQueryRequest): Promise<DBCoreQueryResponse> {
    const store = this.getStore(req.trans);
    const source = this.getIndex(store, req.query);
    const idbRange = toIDBKeyRange(req.query.range);
    const direction: IDBCursorDirection = req.reverse ? "prev" : "next";
    const wantValues = req.values !== false;

    const result: unknown[] = [];
    const keys: unknown[] = [];

    // Handle "any of" queries by doing multiple queries
    if (req.query.range.type === DBCoreRangeType.Any && req.query.range.values) {
      const IDBKeyRange = getIDBKeyRange();
      if (!IDBKeyRange) {
        return { result: [], keys: [] };
      }
      for (const value of req.query.range.values) {
        const singleRange = IDBKeyRange.only(value);

        if (this.useGetAll && !req.offset && source instanceof IDBObjectStore && wantValues) {
          const values = await promisifyRequest(source.getAll(singleRange, req.limit));
          const keyResult = await promisifyRequest(source.getAllKeys(singleRange, req.limit));
          result.push(...values);
          keys.push(...keyResult);
        } else {
          await this.cursorQuery(source, singleRange, direction, req, result, keys, wantValues);
        }

        if (req.limit && result.length >= req.limit) {
          break;
        }
      }

      return {
        result: result.slice(0, req.limit),
        keys: keys.slice(0, req.limit),
      };
    }

    // Handle "not equal" with cursor and filter
    if (req.query.range.type === DBCoreRangeType.NotEqual) {
      await this.cursorQuery(
        source,
        undefined,
        direction,
        req,
        result,
        keys,
        wantValues,
        (_value, _primaryKey, indexKey) => {
          return compareKeys(indexKey, req.query.range.lower) !== 0;
        },
      );
      return { result, keys };
    }

    // Standard query - use getAll only when not reversing
    if (
      this.useGetAll &&
      !req.offset &&
      !req.unique &&
      !req.reverse &&
      source instanceof IDBObjectStore &&
      wantValues
    ) {
      const values = await promisifyRequest(source.getAll(idbRange, req.limit));
      const keyResult = await promisifyRequest(source.getAllKeys(idbRange, req.limit));
      return { result: values, keys: keyResult };
    }

    // Fall back to cursor
    await this.cursorQuery(source, idbRange, direction, req, result, keys, wantValues);
    return { result, keys };
  }

  private cursorQuery(
    source: IDBObjectStore | IDBIndex,
    range: IDBKeyRange | undefined,
    direction: IDBCursorDirection,
    req: DBCoreQueryRequest | DBCoreOpenCursorRequest,
    result: unknown[],
    keys: unknown[],
    wantValues: boolean,
    filter?: (value: unknown, primaryKey: unknown, indexKey: unknown) => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cursorRequest = source.openCursor(range, direction);
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
        if (filter && !filter(cursor.value, cursor.primaryKey, cursor.key)) {
          cursor.continue();
          return;
        }

        // Handle offset
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        // Collect result
        if (wantValues) {
          result.push(cursor.value);
        }
        keys.push(cursor.primaryKey);
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
      const cursorRequest = source.openCursor(idbRange, direction);
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
        const dbCoreCursor: DBCoreCursor = {
          trans: req.trans,
          key: cursor.key,
          primaryKey: cursor.primaryKey,
          value: wantValues ? cursor.value : undefined,
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
        const results: unknown[] = [];
        const failures: Record<number, Error> = {};
        let numFailures = 0;

        for (let i = 0; i < req.values.length; i++) {
          try {
            let value = req.values[i];
            const key = keyPath ? undefined : req.keys?.[i];

            if (keyPath) {
              value = fixUndefinedKey(value as object, keyPath);
            }

            const result = await promisifyRequest(store.add(value, key as IDBValidKey | undefined));
            results.push(result);
          } catch (error) {
            failures[i] = mapError(error);
            numFailures++;
            results.push(undefined);
          }
        }

        return {
          numFailures,
          results,
          failures: numFailures > 0 ? failures : undefined,
          lastResult: results[results.length - 1],
        };
      }

      case "put": {
        const results: unknown[] = [];
        const failures: Record<number, Error> = {};
        let numFailures = 0;

        for (let i = 0; i < req.values.length; i++) {
          try {
            let value = req.values[i];
            const key = keyPath ? undefined : req.keys?.[i];

            if (keyPath) {
              value = fixUndefinedKey(value as object, keyPath);
            }

            const result = await promisifyRequest(store.put(value, key as IDBValidKey | undefined));
            results.push(result);
          } catch (error) {
            failures[i] = mapError(error);
            numFailures++;
            results.push(undefined);
          }
        }

        return {
          numFailures,
          results,
          failures: numFailures > 0 ? failures : undefined,
          lastResult: results[results.length - 1],
        };
      }

      case "delete": {
        const failures: Record<number, Error> = {};
        let numFailures = 0;

        for (let i = 0; i < req.keys.length; i++) {
          try {
            await promisifyRequest(store.delete(req.keys[i] as IDBValidKey));
          } catch (error) {
            failures[i] = mapError(error);
            numFailures++;
          }
        }

        return {
          numFailures,
          failures: numFailures > 0 ? failures : undefined,
        };
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

  transaction(tableNames: string[], mode: TransactionMode): DBCoreTransaction {
    const storeNames = safariMultiStoreFix(tableNames);
    const idbMode = mode === "readwrite" ? "readwrite" : "readonly";
    const idbTrans = this.idbDatabase.transaction(storeNames, idbMode);
    return new IDBCoreTransaction(idbTrans, tableNames, mode);
  }
}

/**
 * Create IDBCore from an open IDBDatabase.
 */
export function createIDBCore(idbDatabase: IDBDatabase, schemas: Map<string, TableSchema>): DBCore {
  return new IDBCore(idbDatabase, schemas);
}
