/**
 * Table class - the primary API for working with a single table.
 */

import type { DBCoreTable, DBCoreTransaction, DBCoreTableSchema } from "./dbcore/index.js";
import { keyRangeAll, primaryKeyQuery } from "./dbcore/index.js";
import { Collection, createCollectionContext } from "./collection.js";
import { WhereClause } from "./where-clause.js";
import { createTableHooks, type TableHooks } from "./events/index.js";
import { ConstraintError } from "./errors/index.js";

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

  // ========================================
  // Single-item operations
  // ========================================

  /**
   * Get a single item by primary key.
   */
  async get(key: TKey): Promise<T | undefined> {
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
  }

  /**
   * Add a new item. Fails if the key already exists.
   */
  async add(item: T, key?: TKey): Promise<TKey> {
    const trans = this._getTransaction();

    // Fire creating hook
    this.hook.creating.fire(key, item);

    const result = await this._coreTable.mutate({
      type: "add",
      trans,
      values: [item],
      keys: key !== undefined ? [key] : undefined,
    });

    if (result.numFailures > 0) {
      const firstError = result.failures?.[0];
      throw firstError ?? new ConstraintError("Add operation failed");
    }

    const resultKey = result.results?.[0];
    if (resultKey === undefined) {
      throw new ConstraintError("Add operation did not return a key");
    }
    return resultKey as TKey;
  }

  /**
   * Add or update an item.
   */
  async put(item: T, key?: TKey): Promise<TKey> {
    const trans = this._getTransaction();

    const result = await this._coreTable.mutate({
      type: "put",
      trans,
      values: [item],
      keys: key !== undefined ? [key] : undefined,
    });

    if (result.numFailures > 0) {
      const firstError = result.failures?.[0];
      throw firstError ?? new ConstraintError("Put operation failed");
    }

    const resultKey = result.results?.[0];
    if (resultKey === undefined) {
      throw new ConstraintError("Put operation did not return a key");
    }
    return resultKey as TKey;
  }

  /**
   * Update an existing item by key.
   * Returns 1 if updated, 0 if not found.
   */
  async update(key: TKey, changes: Partial<T>): Promise<number> {
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
  }

  /**
   * Add or update an item in one call.
   * If the item exists (by key), it merges the changes.
   * If it doesn't exist, it adds the item.
   */
  async upsert(item: T | Partial<T>, key?: TKey): Promise<TKey> {
    const trans = this._getTransaction();

    // Determine the key to check
    const keyPath = this.schema.primaryKey.keyPath;
    const lookupKey =
      key ?? (keyPath ? ((item as Record<string, unknown>)[keyPath] as TKey) : undefined);

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
          throw firstError ?? new ConstraintError("Upsert update failed");
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
      throw firstError ?? new ConstraintError("Upsert add failed");
    }

    const resultKey = result.results?.[0];
    if (resultKey === undefined) {
      throw new ConstraintError("Upsert operation did not return a key");
    }
    return resultKey as TKey;
  }

  /**
   * Delete an item by key.
   */
  async delete(key: TKey): Promise<void> {
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
  }

  // ========================================
  // Bulk operations
  // ========================================

  /**
   * Get multiple items by keys.
   */
  async bulkGet(keys: TKey[]): Promise<(T | undefined)[]> {
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
  }

  /**
   * Add multiple items. Returns array of keys.
   */
  async bulkAdd(items: T[], keys?: TKey[]): Promise<TKey[]> {
    const trans = this._getTransaction();

    // Fire creating hooks
    items.forEach((item, i) => {
      this.hook.creating.fire(keys?.[i], item);
    });

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
  }

  /**
   * Add or update multiple items. Returns array of keys.
   */
  async bulkPut(items: T[], keys?: TKey[]): Promise<TKey[]> {
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
  }

  /**
   * Update multiple items by key. Returns number of items updated.
   */
  async bulkUpdate(keysAndChanges: { key: TKey; changes: Partial<T> }[]): Promise<number> {
    if (keysAndChanges.length === 0) {
      return 0;
    }

    const trans = this._getTransaction();

    // Get all existing items
    const keys = keysAndChanges.map((kc) => kc.key);
    const existingItems = (await this._coreTable.getMany({ trans, keys })) as (T | undefined)[];

    // Prepare updates for items that exist
    const updates: { key: TKey; value: T }[] = [];
    for (let i = 0; i < keysAndChanges.length; i++) {
      const existing = existingItems[i];
      const item = keysAndChanges[i];
      if (existing !== undefined && item !== undefined) {
        this.hook.updating.fire(item.changes, item.key, existing);
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
  }

  /**
   * Delete multiple items by keys.
   */
  async bulkDelete(keys: TKey[]): Promise<void> {
    const trans = this._getTransaction();

    await this._coreTable.mutate({
      type: "delete",
      trans,
      keys,
    });
  }

  // ========================================
  // Full table operations
  // ========================================

  /**
   * Delete all items in the table.
   */
  async clear(): Promise<void> {
    const trans = this._getTransaction();

    await this._coreTable.mutate({
      type: "deleteRange",
      trans,
      range: keyRangeAll(),
    });
  }

  /**
   * Count all items in the table.
   */
  async count(): Promise<number> {
    const trans = this._getTransaction();
    return this._coreTable.count({
      trans,
      query: primaryKeyQuery(this.schema, keyRangeAll()),
    });
  }

  /**
   * Get all items as an array.
   */
  async toArray(): Promise<T[]> {
    return this.toCollection().toArray();
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
