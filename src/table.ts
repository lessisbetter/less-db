/**
 * Table class - the primary API for working with a single table.
 */

import type { DBCoreTable, DBCoreTransaction, DBCoreTableSchema } from "./dbcore/index.js";
import { keyRangeAll, primaryKeyQuery, extractKeyValue } from "./dbcore/index.js";
import { Collection, createCollectionContext } from "./collection.js";
import { WhereClause } from "./where-clause.js";
import { createTableHooks, type TableHooks } from "./events/index.js";
import { ConstraintError } from "./errors/index.js";
import { LessDBPromise } from "./promise.js";

/**
 * Table class for CRUD operations and queries.
 */
export class Table<T, TKey> {
  /** Table name */
  readonly name: string;
  /** Table schema (DBCore schema) */
  readonly schema: DBCoreTableSchema;
  /** Table hooks for lifecycle events */
  readonly hook: TableHooks<T, TKey>;

  /** @internal */
  _coreTable: DBCoreTable;
  /** @internal */
  _getTransaction: () => DBCoreTransaction;

  constructor(
    coreTable: DBCoreTable,
    getTransaction: () => DBCoreTransaction,
    hooks?: TableHooks<T, TKey>,
  ) {
    this._coreTable = coreTable;
    this._getTransaction = getTransaction;
    this.name = coreTable.name;
    this.schema = coreTable.schema;
    this.hook = hooks ?? createTableHooks<T, TKey>();
  }

  /**
   * Wrap an async operation to return LessDBPromise.
   * @internal
   */
  private _wrap<R>(operation: () => Promise<R>): LessDBPromise<R> {
    // Use Promise.resolve().then() to ensure the operation starts in a microtask,
    // giving time for catch handlers to be attached before rejection occurs
    const promise = Promise.resolve().then(operation);
    return new LessDBPromise<R>((resolve, reject) => {
      promise.then(resolve, reject);
    });
  }

  // ========================================
  // Single-item operations
  // ========================================

  /**
   * Get a single item by primary key.
   */
  get(key: TKey): LessDBPromise<T | undefined> {
    return this._wrap(async () => {
      const trans = this._getTransaction();
      let value = (await this._coreTable.get({ trans, key })) as T | undefined;

      // Apply reading hook
      if (value !== undefined && this.hook.reading.hasHandlers()) {
        const transformed = this.hook.reading.fire(value);
        if (transformed !== undefined) {
          value = transformed;
        }
      }

      return value;
    });
  }

  /**
   * Add a new item. Fails if the key already exists.
   */
  add(item: T, key?: TKey): LessDBPromise<TKey> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      // Fire creating hook only if there are handlers
      if (this.hook.creating.hasHandlers()) {
        this.hook.creating.fire(key, item);
      }

      const result = await this._coreTable.mutate({
        type: "add",
        trans,
        values: [item],
        keys: key !== undefined ? [key] : undefined,
      });

      if (result.numFailures > 0) {
        const firstError = result.failures?.[0];
        throw new ConstraintError(firstError?.message ?? "Add operation failed", firstError);
      }

      const resultKey = result.results?.[0];
      if (resultKey === undefined) {
        throw new ConstraintError("Add operation did not return a key");
      }
      return resultKey as TKey;
    });
  }

  /**
   * Add or update an item.
   */
  put(item: T, key?: TKey): LessDBPromise<TKey> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      const result = await this._coreTable.mutate({
        type: "put",
        trans,
        values: [item],
        keys: key !== undefined ? [key] : undefined,
      });

      if (result.numFailures > 0) {
        const firstError = result.failures?.[0];
        throw new ConstraintError(firstError?.message ?? "Put operation failed", firstError);
      }

      const resultKey = result.results?.[0];
      if (resultKey === undefined) {
        throw new ConstraintError("Put operation did not return a key");
      }
      return resultKey as TKey;
    });
  }

  /**
   * Update an existing item by key.
   * Returns 1 if updated, 0 if not found.
   */
  update(key: TKey, changes: Partial<T>): LessDBPromise<number> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      // Get existing item
      const existing = (await this._coreTable.get({ trans, key })) as T | undefined;
      if (!existing) {
        return 0;
      }

      // Fire updating hook
      this.hook.updating.fire(changes, key, existing);

      // Merge changes
      const updated = { ...existing, ...changes } as T;

      const result = await this._coreTable.mutate({
        type: "put",
        trans,
        values: [updated],
        keys: [key],
      });

      return result.numFailures === 0 ? 1 : 0;
    });
  }

  /**
   * Add or update an item in one call.
   * If the item exists (by key), it merges the changes.
   * If it doesn't exist, it adds the item.
   */
  upsert(item: T | Partial<T>, key?: TKey): LessDBPromise<TKey> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      // Determine the key to check
      const keyPath = this.schema.primaryKey.keyPath;
      const lookupKey = key ?? (keyPath ? (extractKeyValue(item, keyPath) as TKey) : undefined);

      if (lookupKey !== undefined) {
        // Try to get existing item
        const existing = (await this._coreTable.get({ trans, key: lookupKey })) as T | undefined;

        if (existing) {
          // Merge and update
          const merged = { ...existing, ...item } as T;
          this.hook.updating.fire(item as Partial<T>, lookupKey, existing);

          const result = await this._coreTable.mutate({
            type: "put",
            trans,
            values: [merged],
            keys: [lookupKey],
          });

          if (result.numFailures > 0) {
            const firstError = result.failures?.[0];
            throw new ConstraintError(firstError?.message ?? "Upsert update failed", firstError);
          }

          return lookupKey;
        }
      }

      // Item doesn't exist, add it
      this.hook.creating.fire(lookupKey, item as T);

      const result = await this._coreTable.mutate({
        type: "add",
        trans,
        values: [item],
        keys: lookupKey !== undefined ? [lookupKey] : undefined,
      });

      if (result.numFailures > 0) {
        const firstError = result.failures?.[0];
        throw new ConstraintError(firstError?.message ?? "Upsert add failed", firstError);
      }

      const resultKey = result.results?.[0];
      if (resultKey === undefined) {
        throw new ConstraintError("Upsert operation did not return a key");
      }
      return resultKey as TKey;
    });
  }

  /**
   * Delete an item by key.
   */
  delete(key: TKey): LessDBPromise<void> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      // Get existing for hook
      if (this.hook.deleting.hasHandlers()) {
        const existing = (await this._coreTable.get({ trans, key })) as T | undefined;
        if (existing) {
          this.hook.deleting.fire(key, existing);
        }
      }

      await this._coreTable.mutate({
        type: "delete",
        trans,
        keys: [key],
      });
    });
  }

  // ========================================
  // Bulk operations
  // ========================================

  /**
   * Get multiple items by keys.
   */
  bulkGet(keys: TKey[]): LessDBPromise<(T | undefined)[]> {
    return this._wrap(async () => {
      const trans = this._getTransaction();
      const values = (await this._coreTable.getMany({ trans, keys })) as (T | undefined)[];

      // Apply reading hooks
      if (this.hook.reading.hasHandlers()) {
        return values.map((value) => {
          if (value === undefined) return undefined;
          const transformed = this.hook.reading.fire(value);
          return transformed !== undefined ? transformed : value;
        });
      }

      return values;
    });
  }

  /**
   * Add multiple items. Returns array of keys.
   */
  bulkAdd(items: T[], keys?: TKey[]): LessDBPromise<TKey[]> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      // Fire creating hooks (only if there are handlers)
      if (this.hook.creating.hasHandlers()) {
        for (let i = 0; i < items.length; i++) {
          this.hook.creating.fire(keys?.[i], items[i]!);
        }
      }

      const result = await this._coreTable.mutate({
        type: "add",
        trans,
        values: items,
        keys,
      });

      if (result.numFailures > 0) {
        const failures = result.failures ?? {};
        const errors = Object.entries(failures).map(([idx, err]) => `[${idx}]: ${err.message}`);
        const message = errors.length > 0 ? errors.join(", ") : `${result.numFailures} error(s)`;
        throw new ConstraintError(`BulkAdd failed: ${message}`);
      }

      return (result.results ?? []) as TKey[];
    });
  }

  /**
   * Add or update multiple items. Returns array of keys.
   */
  bulkPut(items: T[], keys?: TKey[]): LessDBPromise<TKey[]> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      const result = await this._coreTable.mutate({
        type: "put",
        trans,
        values: items,
        keys,
      });

      if (result.numFailures > 0) {
        const failures = result.failures ?? {};
        const errors = Object.entries(failures).map(([idx, err]) => `[${idx}]: ${err.message}`);
        const message = errors.length > 0 ? errors.join(", ") : `${result.numFailures} error(s)`;
        throw new ConstraintError(`BulkPut failed: ${message}`);
      }

      return (result.results ?? []) as TKey[];
    });
  }

  /**
   * Update multiple items by key. Returns number of items updated.
   */
  bulkUpdate(keysAndChanges: { key: TKey; changes: Partial<T> }[]): LessDBPromise<number> {
    return this._wrap(async () => {
      if (keysAndChanges.length === 0) {
        return 0;
      }

      const trans = this._getTransaction();

      // Get all existing items
      const keys = keysAndChanges.map((kc) => kc.key);
      const existingItems = (await this._coreTable.getMany({ trans, keys })) as (T | undefined)[];

      // Prepare updates for items that exist
      const updates: { key: TKey; value: T }[] = [];
      const hasUpdatingHook = this.hook.updating.hasHandlers();

      for (let i = 0; i < keysAndChanges.length; i++) {
        const existing = existingItems[i];
        const item = keysAndChanges[i];
        if (existing !== undefined && item !== undefined) {
          // Only fire hook if there are handlers
          if (hasUpdatingHook) {
            this.hook.updating.fire(item.changes, item.key, existing);
          }
          const merged = { ...existing, ...item.changes } as T;
          updates.push({ key: item.key, value: merged });
        }
      }

      if (updates.length === 0) {
        return 0;
      }

      // Put all updates
      const result = await this._coreTable.mutate({
        type: "put",
        trans,
        values: updates.map((u) => u.value),
        keys: updates.map((u) => u.key),
      });

      if (result.numFailures > 0) {
        const failures = result.failures ?? {};
        const errors = Object.entries(failures).map(([idx, err]) => `[${idx}]: ${err.message}`);
        const message = errors.length > 0 ? errors.join(", ") : `${result.numFailures} error(s)`;
        throw new ConstraintError(`BulkUpdate failed: ${message}`);
      }

      return updates.length;
    });
  }

  /**
   * Delete multiple items by keys.
   */
  bulkDelete(keys: TKey[]): LessDBPromise<void> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      await this._coreTable.mutate({
        type: "delete",
        trans,
        keys,
      });
    });
  }

  // ========================================
  // Full table operations
  // ========================================

  /**
   * Delete all items in the table.
   */
  clear(): LessDBPromise<void> {
    return this._wrap(async () => {
      const trans = this._getTransaction();

      await this._coreTable.mutate({
        type: "deleteRange",
        trans,
        range: keyRangeAll(),
      });
    });
  }

  /**
   * Count all items in the table.
   */
  count(): LessDBPromise<number> {
    return this._wrap(async () => {
      const trans = this._getTransaction();
      return this._coreTable.count({
        trans,
        query: primaryKeyQuery(this.schema, keyRangeAll()),
      });
    });
  }

  /**
   * Get all items as an array.
   */
  toArray(): LessDBPromise<T[]> {
    return this._wrap(async () => {
      return this.toCollection().toArray();
    });
  }

  // ========================================
  // Query entry points
  // ========================================

  /**
   * Create a WhereClause for querying by index.
   */
  where(indexName: string): WhereClause<T, TKey> {
    return new WhereClause(this._coreTable, indexName, this._getTransaction);
  }

  /**
   * Filter all items with a predicate.
   */
  filter(predicate: (item: T) => boolean): Collection<T, TKey> {
    return this.toCollection().filter(predicate);
  }

  /**
   * Order results by an index.
   */
  orderBy(indexName: string): Collection<T, TKey> {
    const ctx = createCollectionContext(this._coreTable);
    ctx.index = indexName;
    return new Collection(ctx, this._getTransaction);
  }

  /**
   * Get a collection of all items.
   */
  toCollection(): Collection<T, TKey> {
    const ctx = createCollectionContext(this._coreTable);
    return new Collection(ctx, this._getTransaction);
  }
}

/**
 * Create a Table instance.
 */
export function createTable<T, TKey>(
  coreTable: DBCoreTable,
  getTransaction: () => DBCoreTransaction,
  hooks?: TableHooks<T, TKey>,
): Table<T, TKey> {
  return new Table(coreTable, getTransaction, hooks);
}
