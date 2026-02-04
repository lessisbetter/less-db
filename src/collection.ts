/**
 * Collection class - represents a filtered/sorted set of records.
 *
 * Collections are lazy - they don't execute until a terminal operation
 * (toArray, first, count, etc.) is called.
 */

import type {
  DBCoreTable,
  DBCoreTransaction,
  DBCoreQueryRequest,
  DBCoreKeyRange,
  DBCoreIndex,
  CursorAlgorithm,
} from "./dbcore/index.js";
import {
  keyRangeRange,
  keyRangeAll,
  primaryKeyQuery,
  indexQuery,
  extractPrimaryKeys,
  extractKeyValue,
} from "./dbcore/index.js";
import { compareKeys } from "./compat/index.js";
import { serializeKey } from "./utils/index.js";

/**
 * Collection context - stores query state.
 */
export interface CollectionContext {
  /** The table being queried */
  table: DBCoreTable;
  /** Index to query (empty string for primary key) */
  index: string;
  /** Key range */
  range: DBCoreKeyRange;
  /** Additional filter function */
  filter?: (item: unknown) => boolean;
  /** Query direction */
  reverse: boolean;
  /** Maximum results */
  limit?: number;
  /** Results to skip */
  offset?: number;
  /** Only unique keys */
  unique: boolean;
  /** Stop iteration predicate */
  until?: (item: unknown) => boolean;
  /** Include the stop item in results */
  includeStopItem?: boolean;
  /** Skip reading hooks (raw mode) */
  raw?: boolean;
  /** Alternative query contexts for OR operations */
  orContexts?: CollectionContext[];
  /** Cursor algorithm for optimized iteration with jumping */
  cursorAlgorithm?: CursorAlgorithm;
}

/**
 * Create initial collection context for full table scan.
 */
export function createCollectionContext(table: DBCoreTable): CollectionContext {
  return {
    table,
    index: "",
    range: keyRangeAll(),
    reverse: false,
    unique: false,
  };
}

/**
 * Clone collection context with modifications.
 */
function cloneContext(ctx: CollectionContext, mods: Partial<CollectionContext>): CollectionContext {
  return { ...ctx, ...mods };
}

/**
 * Build a DBCoreQuery from context.
 */
function buildQuery(ctx: CollectionContext): { index: DBCoreIndex; range: DBCoreKeyRange } {
  if (!ctx.index) {
    return primaryKeyQuery(ctx.table.schema, ctx.range);
  }
  return indexQuery(ctx.table.schema, ctx.index, ctx.range);
}

/**
 * Collection class for query building and execution.
 */
export class Collection<T, TKey> {
  /** @internal */
  _ctx: CollectionContext;
  /** @internal */
  _getTransaction: () => DBCoreTransaction;

  constructor(ctx: CollectionContext, getTransaction: () => DBCoreTransaction) {
    this._ctx = ctx;
    this._getTransaction = getTransaction;
  }

  /**
   * Add an additional filter predicate.
   */
  and(predicate: (item: T) => boolean): Collection<T, TKey> {
    const existingFilter = this._ctx.filter;
    const newFilter = existingFilter
      ? (item: unknown) => existingFilter(item) && predicate(item as T)
      : (item: unknown) => predicate(item as T);

    return new Collection(cloneContext(this._ctx, { filter: newFilter }), this._getTransaction);
  }

  /**
   * Alias for and() - adds a filter predicate.
   */
  filter(predicate: (item: T) => boolean): Collection<T, TKey> {
    return this.and(predicate);
  }

  /**
   * Add an OR clause to combine with another index query.
   * Returns an object with WhereClause-like methods.
   */
  or(indexName: string): OrClause<T, TKey> {
    return new OrClause(this, indexName);
  }

  /**
   * Limit the number of results.
   */
  limit(count: number): Collection<T, TKey> {
    return new Collection(cloneContext(this._ctx, { limit: count }), this._getTransaction);
  }

  /**
   * Skip a number of results.
   */
  offset(count: number): Collection<T, TKey> {
    return new Collection(cloneContext(this._ctx, { offset: count }), this._getTransaction);
  }

  /**
   * Reverse the query direction.
   */
  reverse(): Collection<T, TKey> {
    return new Collection(
      cloneContext(this._ctx, { reverse: !this._ctx.reverse }),
      this._getTransaction,
    );
  }

  /**
   * Alias for reverse() - sort descending.
   */
  desc(): Collection<T, TKey> {
    return this.reverse();
  }

  /**
   * Stop iteration when predicate returns true.
   */
  until(predicate: (item: T) => boolean, includeStopItem = false): Collection<T, TKey> {
    return new Collection(
      cloneContext(this._ctx, {
        until: predicate as (item: unknown) => boolean,
        includeStopItem,
      }),
      this._getTransaction,
    );
  }

  /**
   * Clone this collection.
   */
  clone(): Collection<T, TKey> {
    return new Collection({ ...this._ctx }, this._getTransaction);
  }

  /**
   * Return a collection that skips reading hooks.
   */
  raw(): Collection<T, TKey> {
    return new Collection(cloneContext(this._ctx, { raw: true }), this._getTransaction);
  }

  /**
   * Execute a single context query and return values.
   * Keys can be extracted from values using extractPrimaryKeys when needed.
   */
  private async _executeContext(
    ctx: CollectionContext,
    trans: DBCoreTransaction,
  ): Promise<unknown[]> {
    // Only defer offset/limit to post-processing if we have filter or until
    // Note: cursorAlgorithm handles its own filtering, so no post-filter needed
    const needsPostProcessing = !!(ctx.filter || ctx.until);

    const request: DBCoreQueryRequest = {
      trans,
      query: buildQuery(ctx),
      values: true,
      limit: needsPostProcessing ? undefined : ctx.limit,
      offset: needsPostProcessing ? undefined : ctx.offset,
      reverse: ctx.reverse,
      unique: ctx.unique,
      cursorAlgorithm: ctx.cursorAlgorithm,
      raw: ctx.raw,
    };

    const response = await ctx.table.query(request);
    let values = response.result;

    // Apply filter if present (not needed when using cursorAlgorithm)
    if (ctx.filter) {
      values = values.filter(ctx.filter);
    }

    // Apply until predicate
    if (ctx.until) {
      const truncated: unknown[] = [];
      for (const value of values) {
        if (ctx.until(value)) {
          if (ctx.includeStopItem) {
            truncated.push(value);
          }
          break;
        }
        truncated.push(value);
      }
      values = truncated;
    }

    // Apply offset and limit after filtering (only if not already applied at DB level)
    if (needsPostProcessing) {
      if (ctx.offset) {
        values = values.slice(ctx.offset);
      }
      if (ctx.limit !== undefined) {
        values = values.slice(0, ctx.limit);
      }
    }

    return values;
  }

  /**
   * Execute query and return all matching items.
   */
  async toArray(): Promise<T[]> {
    const ctx = this._ctx;
    const trans = this._getTransaction();
    const hasOrContexts = ctx.orContexts && ctx.orContexts.length > 0;

    // Execute main query
    let values = (await this._executeContext(ctx, trans)) as T[];

    // Handle OR contexts - merge results, deduplicate by primary key
    if (hasOrContexts) {
      const seenKeys = new Set<string>();
      const schema = ctx.table.schema;

      // Track seen keys from main result (extract from values)
      const mainKeys = extractPrimaryKeys(values, schema);
      for (const key of mainKeys) {
        seenKeys.add(serializeKey(key));
      }

      // Execute each OR context and merge
      for (const orCtx of ctx.orContexts!) {
        const orValues = await this._executeContext(orCtx, trans);
        const orKeys = extractPrimaryKeys(orValues, schema);

        for (let i = 0; i < orValues.length; i++) {
          const keyStr = serializeKey(orKeys[i]);
          if (!seenKeys.has(keyStr)) {
            seenKeys.add(keyStr);
            values.push(orValues[i] as T);
          }
        }
      }

      // Re-apply limit after merge (offset was already applied per-context)
      if (ctx.limit !== undefined && values.length > ctx.limit) {
        values = values.slice(0, ctx.limit);
      }
    }

    return values;
  }

  /**
   * Get the first matching item.
   */
  async first(): Promise<T | undefined> {
    const results = await this.limit(1).toArray();
    return results[0];
  }

  /**
   * Get the last matching item.
   */
  async last(): Promise<T | undefined> {
    const results = await this.reverse().limit(1).toArray();
    return results[0];
  }

  /**
   * Count matching items.
   */
  async count(): Promise<number> {
    const ctx = this._ctx;
    const trans = this._getTransaction();

    // If we have filters, until, or OR contexts, we need to fetch and count
    if (ctx.filter || ctx.until || ctx.orContexts) {
      const items = await this.toArray();
      return items.length;
    }

    // For simple range/index queries, use fast DB count
    return ctx.table.count({
      trans,
      query: buildQuery(ctx),
    });
  }

  /**
   * Get primary keys of matching items.
   */
  async primaryKeys(): Promise<TKey[]> {
    const ctx = this._ctx;
    const trans = this._getTransaction();
    const schema = ctx.table.schema;

    // For simple queries (no filter/until), we can use values: false to get keys directly
    const hasPostFiltering = !!(ctx.filter || ctx.until);

    if (!hasPostFiltering && !ctx.orContexts?.length) {
      // Fast path: get keys directly from DB
      const request: DBCoreQueryRequest = {
        trans,
        query: buildQuery(ctx),
        values: false, // Get keys instead of values
        limit: ctx.limit,
        offset: ctx.offset,
        reverse: ctx.reverse,
        unique: ctx.unique,
      };
      const response = await ctx.table.query(request);
      return response.result as TKey[];
    }

    // Complex query: get values and extract keys
    const values = await this._executeContext(ctx, trans);
    let keys = extractPrimaryKeys(values, schema) as TKey[];

    // Handle OR contexts - merge results, deduplicate
    if (ctx.orContexts && ctx.orContexts.length > 0) {
      const seenKeys = new Set<string>();

      // Track seen keys from main result
      for (const key of keys) {
        seenKeys.add(serializeKey(key));
      }

      // Execute each OR context and merge
      for (const orCtx of ctx.orContexts) {
        const orValues = await this._executeContext(orCtx, trans);
        const orKeys = extractPrimaryKeys(orValues, schema);

        for (const key of orKeys) {
          const keyStr = serializeKey(key);
          if (!seenKeys.has(keyStr)) {
            seenKeys.add(keyStr);
            keys.push(key as TKey);
          }
        }
      }

      // Re-apply limit after merge
      if (ctx.limit !== undefined && keys.length > ctx.limit) {
        keys = keys.slice(0, ctx.limit);
      }
    }

    return keys;
  }

  /**
   * Alias for primaryKeys().
   */
  async keys(): Promise<TKey[]> {
    return this.primaryKeys();
  }

  /**
   * Get the first primary key.
   */
  async firstKey(): Promise<TKey | undefined> {
    const keys = await this.limit(1).primaryKeys();
    return keys[0];
  }

  /**
   * Get the last primary key.
   */
  async lastKey(): Promise<TKey | undefined> {
    const keys = await this.reverse().limit(1).primaryKeys();
    return keys[0];
  }

  /**
   * Iterate over each matching item.
   */
  async each(callback: (item: T) => void): Promise<void> {
    const items = await this.toArray();
    for (const item of items) {
      callback(item);
    }
  }

  /**
   * Iterate over each primary key.
   */
  async eachKey(callback: (key: TKey) => void): Promise<void> {
    const keys = await this.primaryKeys();
    for (const key of keys) {
      callback(key);
    }
  }

  /**
   * Alias for eachKey().
   */
  async eachPrimaryKey(callback: (key: TKey) => void): Promise<void> {
    return this.eachKey(callback);
  }

  /**
   * Sort results by a key path (loads all into memory).
   */
  async sortBy(keyPath: string): Promise<T[]> {
    const items = await this.toArray();

    // Extract nested property
    const getValue = (obj: unknown, path: string): unknown => {
      const parts = path.split(".");
      let value: unknown = obj;
      for (const part of parts) {
        if (value == null) return undefined;
        value = (value as Record<string, unknown>)[part];
      }
      return value;
    };

    return items.sort((a, b) => {
      const valA = getValue(a, keyPath);
      const valB = getValue(b, keyPath);
      return compareKeys(valA, valB);
    });
  }

  /**
   * Modify all matching items.
   * Note: Does not support OR queries. Use toArray() and manual updates instead.
   * Note: Does not support outbound key tables (schema "++"). Use cursor iteration instead.
   */
  async modify(changes: Partial<T> | ((item: T) => void | Partial<T>)): Promise<number> {
    const ctx = this._ctx;
    const schema = ctx.table.schema;

    if (ctx.orContexts && ctx.orContexts.length > 0) {
      throw new Error("modify() does not support OR queries. Use toArray() and manual updates.");
    }

    // Outbound key tables can't extract keys from values
    if (schema.primaryKey.keyPath === null) {
      throw new Error(
        "modify() does not support outbound key tables. " +
          "Use cursor iteration or get the keys separately.",
      );
    }

    const trans = this._getTransaction();

    // Get all matching values using _executeContext
    let values = await this._executeContext(ctx, trans);

    // Apply modifications
    const modifiedValues: unknown[] = [];
    for (const value of values) {
      let modified: unknown;

      if (typeof changes === "function") {
        const result = changes(value as T);
        if (result && typeof result === "object") {
          modified = { ...(value as object), ...result };
        } else {
          modified = value;
        }
      } else {
        modified = { ...(value as object), ...changes };
      }

      modifiedValues.push(modified);
    }

    // Extract keys from original values (needed for outbound key tables)
    const keys = extractPrimaryKeys(values, schema);

    // Put all modified values
    if (modifiedValues.length > 0) {
      await ctx.table.mutate({
        type: "put",
        trans,
        values: modifiedValues,
        keys: keys,
      });
    }

    return modifiedValues.length;
  }

  /**
   * Delete all matching items.
   * Note: Does not support OR queries. Use primaryKeys() and bulkDelete() instead.
   * Note: Filtered deletes do not support outbound key tables (schema "++").
   */
  async delete(): Promise<number> {
    const ctx = this._ctx;
    const schema = ctx.table.schema;

    if (ctx.orContexts && ctx.orContexts.length > 0) {
      throw new Error("delete() does not support OR queries. Use primaryKeys() and bulkDelete().");
    }

    const trans = this._getTransaction();

    // If no filter, offset, limit, or index, we can delete the range directly on primary key
    // (deleteRange only works on primary key, not on indexes)
    if (!ctx.filter && !ctx.offset && ctx.limit === undefined && !ctx.index) {
      // Count BEFORE deleting
      const count = await ctx.table.count({
        trans,
        query: primaryKeyQuery(schema, ctx.range),
      });

      await ctx.table.mutate({
        type: "deleteRange",
        trans,
        range: ctx.range,
      });

      return count;
    }

    // For filtered/indexed deletes, we need to extract keys from values
    // This doesn't work for outbound key tables
    if (schema.primaryKey.keyPath === null) {
      throw new Error(
        "delete() with filter/index does not support outbound key tables. " +
          "Use cursor iteration or get the keys separately.",
      );
    }

    // Get values first and extract keys
    const values = await this._executeContext(ctx, trans);
    const keys = extractPrimaryKeys(values, schema);

    if (keys.length > 0) {
      await ctx.table.mutate({
        type: "delete",
        trans,
        keys,
      });
    }

    return keys.length;
  }
}

/**
 * OrClause - provides WhereClause-like methods that create OR combinations.
 *
 * Used like: collection.or('indexName').equals(value)
 * This returns all items from the original collection OR items matching the new clause.
 */
export class OrClause<T, TKey> {
  private baseCollection: Collection<T, TKey>;
  private indexName: string;

  constructor(baseCollection: Collection<T, TKey>, indexName: string) {
    this.baseCollection = baseCollection;
    this.indexName = indexName;
  }

  /**
   * Create a merged collection with the given additional context.
   */
  private createOrCollection(additionalCtx: CollectionContext): Collection<T, TKey> {
    const baseCtx = this.baseCollection._ctx;
    const orContexts = baseCtx.orContexts
      ? [...baseCtx.orContexts, additionalCtx]
      : [additionalCtx];

    return new Collection<T, TKey>(
      cloneContext(baseCtx, { orContexts }),
      this.baseCollection._getTransaction,
    );
  }

  /**
   * Get the indexed value from an item.
   * For compound indexes, returns an array of values.
   */
  private getIndexValue(item: unknown): unknown {
    if (!item || typeof item !== "object") return undefined;
    const ctx = this.baseCollection._ctx;

    if (!this.indexName) {
      return extractKeyValue(item, ctx.table.schema.primaryKey.keyPath);
    }

    // Find the index spec to get its keyPath
    const indexSpec = ctx.table.schema.indexes.find((idx) => idx.name === this.indexName);
    if (indexSpec) {
      return extractKeyValue(item, indexSpec.keyPath);
    }

    // Fall back to treating indexName as a single field
    return (item as Record<string, unknown>)[this.indexName];
  }

  equals(value: unknown): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: { type: 1, lower: value, upper: value }, // Equal range
      reverse: false,
      unique: false,
    });
  }

  notEqual(value: unknown): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const indexValue = this.getIndexValue(item);
        return indexValue !== value;
      },
      reverse: false,
      unique: false,
    });
  }

  anyOf(values: unknown[]): Collection<T, TKey> {
    if (values.length === 0) {
      return this.baseCollection; // No additional matches
    }
    const ctx = this.baseCollection._ctx;
    // For compound indexes, values may be arrays - serialize for comparison
    const serializedValues = new Set(values.map((v) => JSON.stringify(v)));
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => serializedValues.has(JSON.stringify(this.getIndexValue(item))),
      reverse: false,
      unique: false,
    });
  }

  noneOf(values: unknown[]): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    // For compound indexes, values may be arrays - serialize for comparison
    const serializedValues = new Set(values.map((v) => JSON.stringify(v)));
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => !serializedValues.has(JSON.stringify(this.getIndexValue(item))),
      reverse: false,
      unique: false,
    });
  }

  above(value: unknown): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(value, undefined, true, false),
      reverse: false,
      unique: false,
    });
  }

  aboveOrEqual(value: unknown): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(value, undefined, false, false),
      reverse: false,
      unique: false,
    });
  }

  below(value: unknown): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, value, false, true),
      reverse: false,
      unique: false,
    });
  }

  belowOrEqual(value: unknown): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, value, false, false),
      reverse: false,
      unique: false,
    });
  }

  between(
    lower: unknown,
    upper: unknown,
    includeLower = true,
    includeUpper = false,
  ): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(lower, upper, !includeLower, !includeUpper),
      reverse: false,
      unique: false,
    });
  }

  startsWith(prefix: string): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    if (prefix === "") {
      return this.createOrCollection({
        table: ctx.table,
        index: this.indexName,
        range: keyRangeAll(),
        reverse: false,
        unique: false,
      });
    }
    const upperPrefix =
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(prefix, upperPrefix, false, true),
      reverse: false,
      unique: false,
    });
  }

  startsWithIgnoreCase(prefix: string): Collection<T, TKey> {
    if (prefix === "") {
      return this.createOrCollection({
        table: this.baseCollection._ctx.table,
        index: this.indexName,
        range: keyRangeAll(),
        reverse: false,
        unique: false,
      });
    }

    const lowerPrefix = prefix.toLowerCase();
    const upperPrefix = prefix.toUpperCase();
    const ctx = this.baseCollection._ctx;

    // Optimize with range query
    const lowerBound = upperPrefix;
    const upperChar = lowerPrefix.charAt(lowerPrefix.length - 1);
    const upperBound = lowerPrefix.slice(0, -1) + String.fromCharCode(upperChar.charCodeAt(0) + 1);

    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(lowerBound, upperBound, false, true),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== "string") return false;
        return value.toLowerCase().startsWith(lowerPrefix);
      },
      reverse: false,
      unique: false,
    });
  }

  equalsIgnoreCase(value: string): Collection<T, TKey> {
    if (value === "") {
      return this.equals("");
    }

    const lowerValue = value.toLowerCase();
    const upperValue = value.toUpperCase();
    const ctx = this.baseCollection._ctx;

    // Optimize with range query
    const lowerBound = upperValue;
    const lastChar = lowerValue.charAt(lowerValue.length - 1);
    const upperBound = lowerValue.slice(0, -1) + String.fromCharCode(lastChar.charCodeAt(0) + 1);

    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(lowerBound, upperBound, false, true),
      filter: (item: unknown) => {
        const itemValue = this.getIndexValue(item);
        if (typeof itemValue !== "string") return false;
        return itemValue.toLowerCase() === lowerValue;
      },
      reverse: false,
      unique: false,
    });
  }

  anyOfIgnoreCase(values: string[]): Collection<T, TKey> {
    if (values.length === 0) {
      return this.baseCollection; // No additional matches
    }

    const lowerValues = new Set(values.map((v) => v.toLowerCase()));
    const ctx = this.baseCollection._ctx;

    // Empty strings can't be bounded with character ranges
    const hasEmpty = values.some((v) => v === "");
    if (hasEmpty) {
      // Can't optimize with ranges when empty strings are included
      return this.createOrCollection({
        table: ctx.table,
        index: this.indexName,
        range: keyRangeAll(),
        filter: (item: unknown) => {
          const itemValue = this.getIndexValue(item);
          if (typeof itemValue !== "string") return false;
          return lowerValues.has(itemValue.toLowerCase());
        },
        reverse: false,
        unique: false,
      });
    }

    // Optimize with range query covering all values
    const allUpper = values.map((v) => v.toUpperCase()).sort();
    const allLower = values.map((v) => v.toLowerCase()).sort();
    const minBound = allUpper[0] as string;
    const maxValue = allLower[allLower.length - 1] as string;
    const lastChar = maxValue.charAt(maxValue.length - 1);
    const maxBound = maxValue.slice(0, -1) + String.fromCharCode(lastChar.charCodeAt(0) + 1);

    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(minBound, maxBound, false, true),
      filter: (item: unknown) => {
        const itemValue = this.getIndexValue(item);
        if (typeof itemValue !== "string") return false;
        return lowerValues.has(itemValue.toLowerCase());
      },
      reverse: false,
      unique: false,
    });
  }

  startsWithAnyOf(prefixes: string[]): Collection<T, TKey> {
    if (prefixes.length === 0) {
      return this.baseCollection; // No additional matches
    }
    if (prefixes.length === 1) {
      const [prefix] = prefixes;
      return this.startsWith(prefix as string);
    }
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== "string") return false;
        return prefixes.some((prefix) => value.startsWith(prefix));
      },
      reverse: false,
      unique: false,
    });
  }

  startsWithAnyOfIgnoreCase(prefixes: string[]): Collection<T, TKey> {
    if (prefixes.length === 0) {
      return this.baseCollection; // No additional matches
    }

    const lowerPrefixes = prefixes.map((p) => p.toLowerCase());
    const ctx = this.baseCollection._ctx;

    // Optimize with range query covering all prefixes
    const allUpper = prefixes.map((p) => p.toUpperCase()).sort();
    const allLower = prefixes.map((p) => p.toLowerCase()).sort();
    const minBound = allUpper[0] as string;
    const maxPrefix = allLower[allLower.length - 1] as string;
    const lastChar = maxPrefix.charAt(maxPrefix.length - 1);
    const maxBound = maxPrefix.slice(0, -1) + String.fromCharCode(lastChar.charCodeAt(0) + 1);

    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(minBound, maxBound, false, true),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== "string") return false;
        const lowerValue = value.toLowerCase();
        return lowerPrefixes.some((prefix) => lowerValue.startsWith(prefix));
      },
      reverse: false,
      unique: false,
    });
  }

  inAnyRange(
    ranges: [unknown, unknown][],
    options?: { includeLowers?: boolean; includeUppers?: boolean },
  ): Collection<T, TKey> {
    if (ranges.length === 0) {
      return this.baseCollection; // No additional matches
    }
    const includeLowers = options?.includeLowers ?? true;
    const includeUppers = options?.includeUppers ?? false;

    if (ranges.length === 1) {
      const [range] = ranges;
      return this.between(
        (range as [unknown, unknown])[0],
        (range as [unknown, unknown])[1],
        includeLowers,
        includeUppers,
      );
    }

    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        return ranges.some(([lower, upper]) => {
          const cmpLower = compareKeys(value, lower);
          const cmpUpper = compareKeys(value, upper);
          const aboveLower = includeLowers ? cmpLower >= 0 : cmpLower > 0;
          const belowUpper = includeUppers ? cmpUpper <= 0 : cmpUpper < 0;
          return aboveLower && belowUpper;
        });
      },
      reverse: false,
      unique: false,
    });
  }
}
