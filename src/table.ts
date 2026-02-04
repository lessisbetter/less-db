/**
 * Table class - the primary API for working with a single table.
 */

import type { DBCoreTable, DBCoreTransaction } from './dbcore/index.js';
import { keyRangeRange } from './dbcore/index.js';
import type { TableSchema } from './schema-parser.js';
import { Collection, createCollectionContext } from './collection.js';
import { WhereClause } from './where-clause.js';
import { createTableHooks, type TableHooks } from './events/index.js';
import { ConstraintError } from './errors/index.js';

/**
 * Table class for CRUD operations and queries.
 */
export class Table<T, TKey> {
  /** Table name */
  readonly name: string;
  /** Table schema */
  readonly schema: TableSchema;
  /** Table hooks for lifecycle events */
  readonly hook: TableHooks<T, TKey>;

  /** @internal */
  _coreTable: DBCoreTable;
  /** @internal */
  _getTransaction: () => DBCoreTransaction;

  constructor(
    coreTable: DBCoreTable,
    getTransaction: () => DBCoreTransaction,
    hooks?: TableHooks<T, TKey>
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
    let value = (await this._coreTable.get(trans, key)) as T | undefined;

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

    const result = await this._coreTable.mutate(trans, {
      type: 'add',
      values: [item],
      keys: key !== undefined ? [key] : undefined,
    });

    if (result.numFailures > 0) {
      throw result.failures![0];
    }

    return result.results![0] as TKey;
  }

  /**
   * Add or update an item.
   */
  async put(item: T, key?: TKey): Promise<TKey> {
    const trans = this._getTransaction();

    const result = await this._coreTable.mutate(trans, {
      type: 'put',
      values: [item],
      keys: key !== undefined ? [key] : undefined,
    });

    if (result.numFailures > 0) {
      throw result.failures![0];
    }

    return result.results![0] as TKey;
  }

  /**
   * Update an existing item by key.
   * Returns 1 if updated, 0 if not found.
   */
  async update(key: TKey, changes: Partial<T>): Promise<number> {
    const trans = this._getTransaction();

    // Get existing item
    const existing = (await this._coreTable.get(trans, key)) as T | undefined;
    if (!existing) {
      return 0;
    }

    // Fire updating hook
    this.hook.updating.fire(changes, key, existing);

    // Merge changes
    const updated = { ...existing, ...changes } as T;

    const result = await this._coreTable.mutate(trans, {
      type: 'put',
      values: [updated],
      keys: [key],
    });

    return result.numFailures === 0 ? 1 : 0;
  }

  /**
   * Delete an item by key.
   */
  async delete(key: TKey): Promise<void> {
    const trans = this._getTransaction();

    // Get existing for hook
    if (this.hook.deleting.hasHandlers()) {
      const existing = (await this._coreTable.get(trans, key)) as T | undefined;
      if (existing) {
        this.hook.deleting.fire(key, existing);
      }
    }

    await this._coreTable.mutate(trans, {
      type: 'delete',
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
    const values = (await this._coreTable.getMany(trans, keys)) as (T | undefined)[];

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

    const result = await this._coreTable.mutate(trans, {
      type: 'add',
      values: items,
      keys,
    });

    if (result.numFailures > 0) {
      const errors = Object.entries(result.failures!).map(
        ([idx, err]) => `[${idx}]: ${err.message}`
      );
      throw new ConstraintError(`BulkAdd failed: ${errors.join(', ')}`);
    }

    return result.results as TKey[];
  }

  /**
   * Add or update multiple items. Returns array of keys.
   */
  async bulkPut(items: T[], keys?: TKey[]): Promise<TKey[]> {
    const trans = this._getTransaction();

    const result = await this._coreTable.mutate(trans, {
      type: 'put',
      values: items,
      keys,
    });

    if (result.numFailures > 0) {
      const errors = Object.entries(result.failures!).map(
        ([idx, err]) => `[${idx}]: ${err.message}`
      );
      throw new ConstraintError(`BulkPut failed: ${errors.join(', ')}`);
    }

    return result.results as TKey[];
  }

  /**
   * Delete multiple items by keys.
   */
  async bulkDelete(keys: TKey[]): Promise<void> {
    const trans = this._getTransaction();

    await this._coreTable.mutate(trans, {
      type: 'delete',
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

    await this._coreTable.mutate(trans, {
      type: 'deleteRange',
      range: keyRangeRange(undefined, undefined),
    });
  }

  /**
   * Count all items in the table.
   */
  async count(): Promise<number> {
    const trans = this._getTransaction();
    return this._coreTable.count(trans);
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
  hooks?: TableHooks<T, TKey>
): Table<T, TKey> {
  return new Table(coreTable, getTransaction, hooks);
}
