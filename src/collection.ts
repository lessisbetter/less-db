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
} from './dbcore/index.js';
import { keyRangeRange } from './dbcore/index.js';
import { compareKeys } from './compat/index.js';

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
}

/**
 * Create initial collection context for full table scan.
 */
export function createCollectionContext(table: DBCoreTable): CollectionContext {
  return {
    table,
    index: '',
    range: keyRangeRange(undefined, undefined),
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
    return new Collection(cloneContext(this._ctx, { reverse: !this._ctx.reverse }), this._getTransaction);
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
      this._getTransaction
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
   * Execute a single context query and return values with their keys.
   */
  private async _executeContext(
    ctx: CollectionContext,
    trans: DBCoreTransaction
  ): Promise<{ values: unknown[]; keys: unknown[] }> {
    // Only defer offset/limit to post-processing if we have filter or until
    const needsPostProcessing = !!(ctx.filter || ctx.until);

    const request: DBCoreQueryRequest = {
      index: ctx.index,
      range: ctx.range,
      limit: needsPostProcessing ? undefined : ctx.limit,
      offset: needsPostProcessing ? undefined : ctx.offset,
      reverse: ctx.reverse,
      unique: ctx.unique,
    };

    const response = await ctx.table.query(trans, request);
    let values = response.values;
    let keys = response.keys;

    // Apply filter if present
    if (ctx.filter) {
      const filtered: { value: unknown; key: unknown }[] = [];
      for (let i = 0; i < values.length; i++) {
        if (ctx.filter(values[i])) {
          filtered.push({ value: values[i], key: keys[i] });
        }
      }
      values = filtered.map((f) => f.value);
      keys = filtered.map((f) => f.key);
    }

    // Apply until predicate
    if (ctx.until) {
      const truncated: { value: unknown; key: unknown }[] = [];
      for (let i = 0; i < values.length; i++) {
        if (ctx.until(values[i])) {
          if (ctx.includeStopItem) {
            truncated.push({ value: values[i], key: keys[i] });
          }
          break;
        }
        truncated.push({ value: values[i], key: keys[i] });
      }
      values = truncated.map((t) => t.value);
      keys = truncated.map((t) => t.key);
    }

    // Apply offset and limit after filtering (only if not already applied at DB level)
    if (needsPostProcessing) {
      if (ctx.offset) {
        values = values.slice(ctx.offset);
        keys = keys.slice(ctx.offset);
      }
      if (ctx.limit !== undefined) {
        values = values.slice(0, ctx.limit);
        keys = keys.slice(0, ctx.limit);
      }
    }

    return { values, keys };
  }

  /**
   * Execute query and return all matching items.
   */
  async toArray(): Promise<T[]> {
    const ctx = this._ctx;
    const trans = this._getTransaction();

    // Execute main query
    const mainResult = await this._executeContext(ctx, trans);
    let values = mainResult.values as T[];
    let keys = mainResult.keys;

    // Handle OR contexts - merge results, deduplicate by primary key
    if (ctx.orContexts && ctx.orContexts.length > 0) {
      const seenKeys = new Set<string>();

      // Track seen keys from main result
      for (const key of keys) {
        seenKeys.add(JSON.stringify(key));
      }

      // Execute each OR context and merge
      for (const orCtx of ctx.orContexts) {
        const orResult = await this._executeContext(orCtx, trans);

        for (let i = 0; i < orResult.values.length; i++) {
          const keyStr = JSON.stringify(orResult.keys[i]);
          if (!seenKeys.has(keyStr)) {
            seenKeys.add(keyStr);
            values.push(orResult.values[i] as T);
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

    // If we have complex conditions, use toArray and count
    if (ctx.filter || ctx.index || ctx.until || ctx.orContexts) {
      const items = await this.toArray();
      return items.length;
    }

    // Otherwise we can use the DB count on primary key
    return ctx.table.count(trans, ctx.range);
  }

  /**
   * Get primary keys of matching items.
   */
  async primaryKeys(): Promise<TKey[]> {
    const ctx = this._ctx;
    const trans = this._getTransaction();

    // Execute main query
    const mainResult = await this._executeContext(ctx, trans);
    let keys = mainResult.keys as TKey[];

    // Handle OR contexts - merge results, deduplicate
    if (ctx.orContexts && ctx.orContexts.length > 0) {
      const seenKeys = new Set<string>();

      // Track seen keys from main result
      for (const key of keys) {
        seenKeys.add(JSON.stringify(key));
      }

      // Execute each OR context and merge
      for (const orCtx of ctx.orContexts) {
        const orResult = await this._executeContext(orCtx, trans);

        for (const key of orResult.keys) {
          const keyStr = JSON.stringify(key);
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
      const parts = path.split('.');
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
   */
  async modify(changes: Partial<T> | ((item: T) => void | Partial<T>)): Promise<number> {
    const ctx = this._ctx;

    if (ctx.orContexts && ctx.orContexts.length > 0) {
      throw new Error('modify() does not support OR queries. Use toArray() and manual updates.');
    }

    const trans = this._getTransaction();

    // Get all matching items with their keys
    const request: DBCoreQueryRequest = {
      index: ctx.index,
      range: ctx.range,
      reverse: ctx.reverse,
      unique: ctx.unique,
    };

    const response = await ctx.table.query(trans, request);
    let values = response.values;
    let keys = response.keys;

    // Apply filter
    if (ctx.filter) {
      const filtered: { value: unknown; key: unknown }[] = [];
      for (let i = 0; i < values.length; i++) {
        if (ctx.filter(values[i])) {
          filtered.push({ value: values[i], key: keys[i] });
        }
      }
      values = filtered.map((f) => f.value);
      keys = filtered.map((f) => f.key);
    }

    // Apply offset and limit
    if (ctx.offset) {
      values = values.slice(ctx.offset);
      keys = keys.slice(ctx.offset);
    }
    if (ctx.limit !== undefined) {
      values = values.slice(0, ctx.limit);
      keys = keys.slice(0, ctx.limit);
    }

    // Apply modifications
    const modifiedValues: unknown[] = [];
    for (const value of values) {
      let modified: unknown;

      if (typeof changes === 'function') {
        const result = changes(value as T);
        if (result && typeof result === 'object') {
          modified = { ...value as object, ...result };
        } else {
          modified = value;
        }
      } else {
        modified = { ...value as object, ...changes };
      }

      modifiedValues.push(modified);
    }

    // Put all modified values
    if (modifiedValues.length > 0) {
      await ctx.table.mutate(trans, {
        type: 'put',
        values: modifiedValues,
        keys: keys,
      });
    }

    return modifiedValues.length;
  }

  /**
   * Delete all matching items.
   * Note: Does not support OR queries. Use primaryKeys() and bulkDelete() instead.
   */
  async delete(): Promise<number> {
    const ctx = this._ctx;

    if (ctx.orContexts && ctx.orContexts.length > 0) {
      throw new Error('delete() does not support OR queries. Use primaryKeys() and bulkDelete().');
    }

    const trans = this._getTransaction();

    // If no filter, offset, limit, or index, we can delete the range directly on primary key
    // (deleteRange only works on primary key, not on indexes)
    if (!ctx.filter && !ctx.offset && ctx.limit === undefined && !ctx.index) {
      // Count BEFORE deleting
      const count = await ctx.table.count(trans, ctx.range);

      await ctx.table.mutate(trans, {
        type: 'deleteRange',
        range: ctx.range,
      });

      return count;
    }

    // Otherwise, get keys first (using same transaction), then delete them
    const request: DBCoreQueryRequest = {
      index: ctx.index,
      range: ctx.range,
      reverse: ctx.reverse,
      unique: ctx.unique,
    };

    const response = await ctx.table.query(trans, request);
    let keys = response.keys;

    // Apply filter if present
    if (ctx.filter) {
      const filteredKeys: unknown[] = [];
      for (let i = 0; i < response.values.length; i++) {
        if (ctx.filter(response.values[i])) {
          filteredKeys.push(response.keys[i]);
        }
      }
      keys = filteredKeys;
    }

    // Apply offset and limit
    if (ctx.offset) {
      keys = keys.slice(ctx.offset);
    }
    if (ctx.limit !== undefined) {
      keys = keys.slice(0, ctx.limit);
    }

    if (keys.length > 0) {
      await ctx.table.mutate(trans, {
        type: 'delete',
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
    const orContexts = baseCtx.orContexts ? [...baseCtx.orContexts, additionalCtx] : [additionalCtx];

    return new Collection<T, TKey>(
      cloneContext(baseCtx, { orContexts }),
      this.baseCollection._getTransaction
    );
  }

  /**
   * Get the indexed value from an item.
   */
  private getIndexValue(item: unknown): unknown {
    if (!item || typeof item !== 'object') return undefined;
    const ctx = this.baseCollection._ctx;

    if (!this.indexName) {
      const keyPath = ctx.table.schema.primaryKey.keyPath;
      if (!keyPath) return undefined;
      return (item as Record<string, unknown>)[keyPath];
    }

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
      range: keyRangeRange(undefined, undefined),
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
    const valueSet = new Set(values);
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
      filter: (item: unknown) => valueSet.has(this.getIndexValue(item)),
      reverse: false,
      unique: false,
    });
  }

  noneOf(values: unknown[]): Collection<T, TKey> {
    const ctx = this.baseCollection._ctx;
    const valueSet = new Set(values);
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
      filter: (item: unknown) => !valueSet.has(this.getIndexValue(item)),
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

  between(lower: unknown, upper: unknown, includeLower = true, includeUpper = false): Collection<T, TKey> {
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
    if (prefix === '') {
      return this.createOrCollection({
        table: ctx.table,
        index: this.indexName,
        range: keyRangeRange(undefined, undefined),
        reverse: false,
        unique: false,
      });
    }
    const upperPrefix = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(prefix, upperPrefix, false, true),
      reverse: false,
      unique: false,
    });
  }

  startsWithIgnoreCase(prefix: string): Collection<T, TKey> {
    const lowerPrefix = prefix.toLowerCase();
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== 'string') return false;
        return value.toLowerCase().startsWith(lowerPrefix);
      },
      reverse: false,
      unique: false,
    });
  }

  equalsIgnoreCase(value: string): Collection<T, TKey> {
    const lowerValue = value.toLowerCase();
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
      filter: (item: unknown) => {
        const itemValue = this.getIndexValue(item);
        if (typeof itemValue !== 'string') return false;
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
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
      filter: (item: unknown) => {
        const itemValue = this.getIndexValue(item);
        if (typeof itemValue !== 'string') return false;
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
      return this.startsWith(prefixes[0]);
    }
    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== 'string') return false;
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
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== 'string') return false;
        const lowerValue = value.toLowerCase();
        return lowerPrefixes.some((prefix) => lowerValue.startsWith(prefix));
      },
      reverse: false,
      unique: false,
    });
  }

  inAnyRange(
    ranges: [unknown, unknown][],
    options?: { includeLowers?: boolean; includeUppers?: boolean }
  ): Collection<T, TKey> {
    if (ranges.length === 0) {
      return this.baseCollection; // No additional matches
    }
    const includeLowers = options?.includeLowers ?? true;
    const includeUppers = options?.includeUppers ?? false;

    if (ranges.length === 1) {
      return this.between(ranges[0][0], ranges[0][1], includeLowers, includeUppers);
    }

    const ctx = this.baseCollection._ctx;
    return this.createOrCollection({
      table: ctx.table,
      index: this.indexName,
      range: keyRangeRange(undefined, undefined),
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
