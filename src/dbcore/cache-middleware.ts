/**
 * Transaction-level cache middleware.
 *
 * Caches getMany results within a transaction to avoid redundant database reads.
 * This is particularly beneficial for operations like bulkUpdate that need to
 * read existing values before updating them.
 *
 * Based on Dexie's cache-existing-values-middleware pattern.
 */

import type {
  DBCore,
  DBCoreTable,
  DBCoreTransaction,
  DBCoreGetManyRequest,
  DBCoreMutateRequest,
  DBCoreMutateResponse,
} from "./types.js";

/** Symbol for accessing the transaction cache */
const CACHE_KEY = "_cache";

/** Cache entry for a table */
interface TableCache {
  /** Cached values by key (serialized) */
  values: Map<string, unknown>;
}

/** Transaction cache structure */
interface TransactionCache {
  [tableName: string]: TableCache;
}

/**
 * Get or create the cache on a transaction.
 */
function getTransactionCache(trans: DBCoreTransaction): TransactionCache {
  let cache = (trans as unknown as Record<string, TransactionCache>)[CACHE_KEY];
  if (!cache) {
    cache = {};
    (trans as unknown as Record<string, TransactionCache>)[CACHE_KEY] = cache;
  }
  return cache;
}

/**
 * Get or create table cache within transaction cache.
 */
function getTableCache(transCache: TransactionCache, tableName: string): TableCache {
  let tableCache = transCache[tableName];
  if (!tableCache) {
    tableCache = { values: new Map() };
    transCache[tableName] = tableCache;
  }
  return tableCache;
}

/**
 * Serialize a key for use as a Map key.
 * Uses JSON.stringify consistently to avoid collisions between
 * different types (e.g., numeric 1 vs string "1").
 */
function serializeKey(key: unknown): string {
  return JSON.stringify(key);
}

/**
 * Invalidate entire cache for a table.
 */
function invalidateTableCache(transCache: TransactionCache, tableName: string): void {
  delete transCache[tableName];
}

/**
 * Remove specific keys from the cache.
 */
function invalidateCacheKeys(
  transCache: TransactionCache,
  tableName: string,
  keys: unknown[],
): void {
  const tableCache = transCache[tableName];
  if (!tableCache) return;

  for (const key of keys) {
    tableCache.values.delete(serializeKey(key));
  }
}

/**
 * Create a cached table wrapper.
 */
function createCachedTable(downTable: DBCoreTable): DBCoreTable {
  return {
    // Forward all properties and methods from downstream
    name: downTable.name,
    schema: downTable.schema,
    get: downTable.get.bind(downTable),
    query: downTable.query.bind(downTable),
    openCursor: downTable.openCursor.bind(downTable),
    count: downTable.count.bind(downTable),

    // Override getMany with caching
    async getMany(req: DBCoreGetManyRequest): Promise<unknown[]> {
      const transCache = getTransactionCache(req.trans);
      const tableCache = getTableCache(transCache, downTable.name);
      const { keys } = req;
      const length = keys.length;

      if (length === 0) return [];

      // Check which keys are already cached
      const uncachedKeys: unknown[] = [];
      const uncachedIndices: number[] = [];
      const result: unknown[] = new Array(length);

      for (let i = 0; i < length; i++) {
        const key = keys[i];
        const serialized = serializeKey(key);

        if (tableCache.values.has(serialized)) {
          result[i] = tableCache.values.get(serialized);
        } else {
          uncachedKeys.push(key);
          uncachedIndices.push(i);
        }
      }

      // Fetch uncached keys from downstream
      if (uncachedKeys.length > 0) {
        const fetchedValues = await downTable.getMany({
          trans: req.trans,
          keys: uncachedKeys,
        });

        // Store fetched values in cache and result
        // Note: We only cache found values, not undefined (misses).
        // This is because an `add` operation could insert a record for a
        // previously-missing key, and we don't want to return stale undefined.
        for (let j = 0; j < uncachedKeys.length; j++) {
          const key = uncachedKeys[j];
          const value = fetchedValues[j];
          const serialized = serializeKey(key);
          const resultIndex = uncachedIndices[j];

          if (value !== undefined) {
            tableCache.values.set(serialized, value);
          }
          result[resultIndex!] = value;
        }
      }

      return result;
    },

    // Override mutate with cache invalidation
    async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
      const transCache = getTransactionCache(req.trans);

      // Smart cache invalidation based on mutation type
      switch (req.type) {
        case "add":
          // Add can't change existing values, no invalidation needed
          break;
        case "delete":
          // Delete only affects specific keys - invalidate just those
          invalidateCacheKeys(transCache, downTable.name, req.keys);
          break;
        case "put":
          // Put can change existing values - invalidate specific keys if known
          if (req.keys && req.keys.length > 0) {
            invalidateCacheKeys(transCache, downTable.name, req.keys);
          } else {
            // No keys provided, invalidate entire table cache
            invalidateTableCache(transCache, downTable.name);
          }
          break;
        case "deleteRange":
          // Range operations - invalidate entire table cache
          invalidateTableCache(transCache, downTable.name);
          break;
      }

      return downTable.mutate(req);
    },
  };
}

/**
 * Create the cache middleware.
 *
 * This middleware operates at level -1, closest to IndexedDB,
 * so that higher-level middleware (like hooks) can benefit from caching.
 */
export function createCacheMiddleware(): {
  stack: "dbcore";
  name: string;
  level: number;
  create: (downCore: DBCore) => Partial<DBCore>;
} {
  const tableCache = new Map<string, DBCoreTable>();

  return {
    stack: "dbcore",
    name: "cache",
    level: -1, // Closest to IndexedDB

    create(downCore: DBCore): Partial<DBCore> {
      return {
        table(name: string): DBCoreTable {
          let cached = tableCache.get(name);
          if (!cached) {
            const downTable = downCore.table(name);
            cached = createCachedTable(downTable);
            tableCache.set(name, cached);
          }
          return cached;
        },
      };
    },
  };
}
