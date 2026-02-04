/**
 * IndexedDB adapter - implements DBCore interface using native IndexedDB.
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
  type DBCoreQueryRequest,
  type DBCoreQueryResponse,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreKeyRange,
  type DBCoreCursorCallback,
  type TransactionMode,
  DBCoreRangeType,
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
 * IndexedDB implementation of DBCoreTable.
 */
class IDBCoreTable implements DBCoreTable {
  readonly name: string;
  readonly schema: TableSchema;
  private useGetAll: boolean;

  constructor(name: string, schema: TableSchema) {
    this.name = name;
    this.schema = schema;
    this.useGetAll = hasWorkingGetAll();
  }

  private getStore(trans: DBCoreTransaction): IDBObjectStore {
    return trans.idbTransaction.objectStore(this.name);
  }

  private getIndex(store: IDBObjectStore, indexName: string): IDBObjectStore | IDBIndex {
    if (!indexName || indexName === this.schema.primaryKey.name) {
      return store;
    }
    return store.index(indexName);
  }

  async get(trans: DBCoreTransaction, key: unknown): Promise<unknown> {
    const store = this.getStore(trans);
    return promisifyRequest(store.get(key as IDBValidKey));
  }

  async getMany(trans: DBCoreTransaction, keys: unknown[]): Promise<unknown[]> {
    const store = this.getStore(trans);
    // Individual gets in parallel - IDB batches these efficiently within the transaction
    return Promise.all(keys.map((key) => promisifyRequest(store.get(key as IDBValidKey))));
  }

  async query(trans: DBCoreTransaction, request: DBCoreQueryRequest): Promise<DBCoreQueryResponse> {
    const store = this.getStore(trans);
    const source = this.getIndex(store, request.index);
    const idbRange = toIDBKeyRange(request.range);
    const direction: IDBCursorDirection = request.reverse ? "prev" : "next";

    const values: unknown[] = [];
    const keys: unknown[] = [];

    // Handle "any of" queries by doing multiple queries
    if (request.range.type === DBCoreRangeType.Any && request.range.values) {
      const IDBKeyRange = getIDBKeyRange();
      if (!IDBKeyRange) {
        // Fallback: can't do range queries without IDBKeyRange
        return { values: [], keys: [] };
      }
      for (const value of request.range.values) {
        const singleRange = IDBKeyRange.only(value);

        if (this.useGetAll && !request.offset && source instanceof IDBObjectStore) {
          const result = await promisifyRequest(source.getAll(singleRange, request.limit));
          const keyResult = await promisifyRequest(source.getAllKeys(singleRange, request.limit));
          values.push(...result);
          keys.push(...keyResult);
        } else {
          await this.cursorQuery(source, singleRange, direction, request, values, keys);
        }

        if (request.limit && values.length >= request.limit) {
          break;
        }
      }

      return { values: values.slice(0, request.limit), keys: keys.slice(0, request.limit) };
    }

    // Handle "not equal" with cursor and filter
    if (request.range.type === DBCoreRangeType.NotEqual) {
      await this.cursorQuery(source, undefined, direction, request, values, keys, (_value, key) => {
        return compareKeys(key, request.range.lower) !== 0;
      });
      return { values, keys };
    }

    // Standard query - use getAll only when not reversing (getAll doesn't support direction)
    if (
      this.useGetAll &&
      !request.offset &&
      !request.unique &&
      !request.reverse &&
      source instanceof IDBObjectStore
    ) {
      const result = await promisifyRequest(source.getAll(idbRange, request.limit));
      const keyResult = await promisifyRequest(source.getAllKeys(idbRange, request.limit));
      return { values: result, keys: keyResult };
    }

    // Fall back to cursor
    await this.cursorQuery(source, idbRange, direction, request, values, keys);
    return { values, keys };
  }

  private cursorQuery(
    source: IDBObjectStore | IDBIndex,
    range: IDBKeyRange | undefined,
    direction: IDBCursorDirection,
    request: DBCoreQueryRequest,
    values: unknown[],
    keys: unknown[],
    filter?: (value: unknown, key: unknown) => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cursorRequest = source.openCursor(range, direction);
      let skipped = 0;
      let collected = 0;
      const limit = request.limit ?? Infinity;
      const offset = request.offset ?? 0;
      let lastKey: unknown;

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor) {
          resolve();
          return;
        }

        // Handle unique filter
        if (request.unique && cursor.key === lastKey) {
          cursor.continue();
          return;
        }
        lastKey = cursor.key;

        // Apply custom filter
        if (filter && !filter(cursor.value, cursor.primaryKey)) {
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
        values.push(cursor.value);
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

  async openCursor(
    trans: DBCoreTransaction,
    request: DBCoreQueryRequest,
    callback: DBCoreCursorCallback,
  ): Promise<void> {
    const store = this.getStore(trans);
    const source = this.getIndex(store, request.index);
    const idbRange = toIDBKeyRange(request.range);
    const direction: IDBCursorDirection = request.reverse ? "prev" : "next";

    return new Promise((resolve, reject) => {
      const cursorRequest = source.openCursor(idbRange, direction);
      let stopped = false;
      let skipped = 0;
      let collected = 0;
      const limit = request.limit ?? Infinity;
      const offset = request.offset ?? 0;

      cursorRequest.onsuccess = () => {
        if (stopped) {
          resolve();
          return;
        }

        const cursor = cursorRequest.result;

        if (!cursor) {
          callback(null);
          resolve();
          return;
        }

        // Handle offset
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        // Check limit
        if (collected >= limit) {
          callback(null);
          resolve();
          return;
        }

        collected++;

        callback({
          key: cursor.key,
          primaryKey: cursor.primaryKey,
          value: cursor.value,
          continue: () => {
            if (!stopped) cursor.continue();
          },
          advance: (count: number) => {
            if (!stopped) cursor.advance(count);
          },
          stop: () => {
            stopped = true;
            resolve();
          },
        });
      };

      cursorRequest.onerror = () => reject(mapError(cursorRequest.error));
    });
  }

  async count(trans: DBCoreTransaction, range?: DBCoreKeyRange): Promise<number> {
    const store = this.getStore(trans);
    const idbRange = range ? toIDBKeyRange(range) : undefined;
    return promisifyRequest(store.count(idbRange));
  }

  async mutate(
    trans: DBCoreTransaction,
    request: DBCoreMutateRequest,
  ): Promise<DBCoreMutateResponse> {
    const store = this.getStore(trans);
    const keyPath = this.schema.primaryKey.keyPath;

    switch (request.type) {
      case "add": {
        const results: unknown[] = [];
        const failures: Record<number, Error> = {};
        let numFailures = 0;

        for (let i = 0; i < (request.values?.length ?? 0); i++) {
          try {
            let value = request.values![i];
            // Only use external key if store doesn't have keyPath (outbound)
            const key = keyPath ? undefined : request.keys?.[i];

            // Fix undefined key issue
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
          lastKey: results[results.length - 1],
        };
      }

      case "put": {
        const results: unknown[] = [];
        const failures: Record<number, Error> = {};
        let numFailures = 0;

        for (let i = 0; i < (request.values?.length ?? 0); i++) {
          try {
            let value = request.values![i];
            // Only use external key if store doesn't have keyPath (outbound)
            const key = keyPath ? undefined : request.keys?.[i];

            // Fix undefined key issue
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
          lastKey: results[results.length - 1],
        };
      }

      case "delete": {
        const failures: Record<number, Error> = {};
        let numFailures = 0;

        for (let i = 0; i < (request.keys?.length ?? 0); i++) {
          try {
            await promisifyRequest(store.delete(request.keys![i] as IDBValidKey));
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
          if (request.range) {
            const idbRange = toIDBKeyRange(request.range);
            if (idbRange) {
              await promisifyRequest(store.delete(idbRange));
            } else {
              // Delete all (full range)
              await promisifyRequest(store.clear());
            }
          } else {
            // No range specified - delete all
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
 * IndexedDB implementation of DBCoreTransaction.
 */
class IDBCoreTransaction implements DBCoreTransaction {
  readonly mode: TransactionMode;
  readonly tables: string[];
  readonly idbTransaction: IDBTransaction;

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
 * IndexedDB implementation of DBCore.
 */
export class IDBCore implements DBCore {
  readonly tables = new Map<string, DBCoreTable>();
  private idbDatabase: IDBDatabase;

  constructor(idbDatabase: IDBDatabase, schemas: Map<string, TableSchema>) {
    this.idbDatabase = idbDatabase;

    for (const [name, schema] of schemas) {
      this.tables.set(name, new IDBCoreTable(name, schema));
    }
  }

  table(name: string): DBCoreTable {
    const table = this.tables.get(name);
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
