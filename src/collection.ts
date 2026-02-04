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
   * Execute query and return all matching items.
   */
  async toArray(): Promise<T[]> {
    const ctx = this._ctx;
    const trans = this._getTransaction();

    const request: DBCoreQueryRequest = {
      index: ctx.index,
      range: ctx.range,
      limit: ctx.filter ? undefined : ctx.limit, // Can't limit at DB level if filtering
      offset: ctx.filter ? undefined : ctx.offset,
      reverse: ctx.reverse,
      unique: ctx.unique,
    };

    const response = await ctx.table.query(trans, request);
    let values = response.values as T[];

    // Apply filter if present
    if (ctx.filter) {
      values = values.filter(ctx.filter as (item: T) => boolean);

      // Apply offset and limit after filtering
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

    // If we have a filter or using an index, we need to query and count
    // (IDB count() only works on primary key)
    if (ctx.filter || ctx.index) {
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

    const request: DBCoreQueryRequest = {
      index: ctx.index,
      range: ctx.range,
      limit: ctx.filter ? undefined : ctx.limit,
      offset: ctx.filter ? undefined : ctx.offset,
      reverse: ctx.reverse,
      unique: ctx.unique,
    };

    const response = await ctx.table.query(trans, request);
    let keys = response.keys as TKey[];

    // If we have a filter, we need to filter by values then return corresponding keys
    if (ctx.filter) {
      const filteredIndices: number[] = [];
      response.values.forEach((value, i) => {
        if (ctx.filter!(value)) {
          filteredIndices.push(i);
        }
      });

      keys = filteredIndices.map((i) => response.keys[i] as TKey);

      if (ctx.offset) {
        keys = keys.slice(ctx.offset);
      }
      if (ctx.limit !== undefined) {
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
   * Iterate over each matching item.
   */
  async each(callback: (item: T) => void): Promise<void> {
    const items = await this.toArray();
    for (const item of items) {
      callback(item);
    }
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
   */
  async modify(changes: Partial<T> | ((item: T) => void | Partial<T>)): Promise<number> {
    const ctx = this._ctx;
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
   */
  async delete(): Promise<number> {
    const ctx = this._ctx;
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
