/**
 * WhereClause class - builds index queries that return Collections.
 */

import type { DBCoreTable, DBCoreTransaction, DBCoreKeyRange } from "./dbcore/index.js";
import {
  keyRangeEqual,
  keyRangeRange,
  keyRangeAll,
  keyRangeAnyOf,
  keyRangeAbove,
  keyRangeBelow,
  DBCoreRangeType,
} from "./dbcore/index.js";
import { Collection, type CollectionContext } from "./collection.js";
import { compareKeys } from "./compat/index.js";

/**
 * WhereClause for building index queries.
 */
export class WhereClause<T, TKey> {
  private table: DBCoreTable;
  private indexName: string;
  private getTransaction: () => DBCoreTransaction;

  constructor(table: DBCoreTable, indexName: string, getTransaction: () => DBCoreTransaction) {
    this.table = table;
    this.indexName = indexName;
    this.getTransaction = getTransaction;
  }

  /**
   * Create a collection with the given range.
   */
  private toCollection(range: DBCoreKeyRange): Collection<T, TKey> {
    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range,
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }

  /**
   * Match a single value.
   */
  equals(value: unknown): Collection<T, TKey> {
    return this.toCollection(keyRangeEqual(value));
  }

  /**
   * Match any value except the given one.
   */
  notEqual(value: unknown): Collection<T, TKey> {
    return this.toCollection({
      type: DBCoreRangeType.NotEqual,
      lower: value,
    });
  }

  /**
   * Match any of the given values.
   */
  anyOf(values: unknown[]): Collection<T, TKey> {
    if (values.length === 0) {
      // Empty range - return empty collection with always-false filter
      const ctx: CollectionContext = {
        table: this.table,
        index: this.indexName,
        range: keyRangeAll(),
        filter: () => false,
        reverse: false,
        unique: false,
      };
      return new Collection(ctx, this.getTransaction);
    }
    if (values.length === 1) {
      return this.equals(values[0]);
    }
    return this.toCollection(keyRangeAnyOf(values));
  }

  /**
   * Match none of the given values.
   */
  noneOf(values: unknown[]): Collection<T, TKey> {
    if (values.length === 0) {
      // Match everything
      return this.toCollection(keyRangeAll());
    }

    // Use filter for this
    const valueSet = new Set(values);
    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        // Get the indexed value from the item
        const indexValue = this.getIndexValue(item);
        return !valueSet.has(indexValue);
      },
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }

  /**
   * Get the indexed value from an item.
   */
  private getIndexValue(item: unknown): unknown {
    if (!item || typeof item !== "object") return undefined;

    // Handle primary key
    if (!this.indexName) {
      const keyPath = this.table.schema.primaryKey.keyPath;
      if (!keyPath) return undefined;
      return (item as Record<string, unknown>)[keyPath];
    }

    return (item as Record<string, unknown>)[this.indexName];
  }

  /**
   * Match values greater than the given value.
   */
  above(value: unknown): Collection<T, TKey> {
    return this.toCollection(keyRangeAbove(value, true));
  }

  /**
   * Match values greater than or equal to the given value.
   */
  aboveOrEqual(value: unknown): Collection<T, TKey> {
    return this.toCollection(keyRangeAbove(value, false));
  }

  /**
   * Match values less than the given value.
   */
  below(value: unknown): Collection<T, TKey> {
    return this.toCollection(keyRangeBelow(value, true));
  }

  /**
   * Match values less than or equal to the given value.
   */
  belowOrEqual(value: unknown): Collection<T, TKey> {
    return this.toCollection(keyRangeBelow(value, false));
  }

  /**
   * Match values between lower and upper bounds.
   */
  between(
    lower: unknown,
    upper: unknown,
    includeLower = true,
    includeUpper = false,
  ): Collection<T, TKey> {
    return this.toCollection(keyRangeRange(lower, upper, !includeLower, !includeUpper));
  }

  /**
   * Match strings that start with the given prefix.
   */
  startsWith(prefix: string): Collection<T, TKey> {
    if (prefix === "") {
      // Empty prefix matches everything
      return this.toCollection(keyRangeAll());
    }

    // Create range from prefix to prefix + max char
    const upperPrefix =
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.toCollection(keyRangeRange(prefix, upperPrefix, false, true));
  }

  /**
   * Match strings that start with the given prefix (case-insensitive).
   */
  startsWithIgnoreCase(prefix: string): Collection<T, TKey> {
    const lowerPrefix = prefix.toLowerCase();

    // Use filter for case-insensitive matching
    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== "string") return false;
        return value.toLowerCase().startsWith(lowerPrefix);
      },
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }

  /**
   * Match strings that equal the given value (case-insensitive).
   */
  equalsIgnoreCase(value: string): Collection<T, TKey> {
    const lowerValue = value.toLowerCase();

    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const itemValue = this.getIndexValue(item);
        if (typeof itemValue !== "string") return false;
        return itemValue.toLowerCase() === lowerValue;
      },
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }

  /**
   * Match any of the given values (case-insensitive).
   */
  anyOfIgnoreCase(values: string[]): Collection<T, TKey> {
    if (values.length === 0) {
      // Empty array - return empty collection
      const ctx: CollectionContext = {
        table: this.table,
        index: this.indexName,
        range: keyRangeAll(),
        filter: () => false,
        reverse: false,
        unique: false,
      };
      return new Collection(ctx, this.getTransaction);
    }

    const lowerValues = new Set(values.map((v) => v.toLowerCase()));

    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const itemValue = this.getIndexValue(item);
        if (typeof itemValue !== "string") return false;
        return lowerValues.has(itemValue.toLowerCase());
      },
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }

  /**
   * Match strings that start with any of the given prefixes.
   */
  startsWithAnyOf(prefixes: string[]): Collection<T, TKey> {
    if (prefixes.length === 0) {
      // Empty array - return empty collection
      const ctx: CollectionContext = {
        table: this.table,
        index: this.indexName,
        range: keyRangeAll(),
        filter: () => false,
        reverse: false,
        unique: false,
      };
      return new Collection(ctx, this.getTransaction);
    }

    if (prefixes.length === 1) {
      const [prefix] = prefixes;
      return this.startsWith(prefix as string);
    }

    // Use filter for multiple prefixes
    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== "string") return false;
        return prefixes.some((prefix) => value.startsWith(prefix));
      },
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }

  /**
   * Match strings that start with any of the given prefixes (case-insensitive).
   */
  startsWithAnyOfIgnoreCase(prefixes: string[]): Collection<T, TKey> {
    if (prefixes.length === 0) {
      // Empty array - return empty collection
      const ctx: CollectionContext = {
        table: this.table,
        index: this.indexName,
        range: keyRangeAll(),
        filter: () => false,
        reverse: false,
        unique: false,
      };
      return new Collection(ctx, this.getTransaction);
    }

    const lowerPrefixes = prefixes.map((p) => p.toLowerCase());

    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        if (typeof value !== "string") return false;
        const lowerValue = value.toLowerCase();
        return lowerPrefixes.some((prefix) => lowerValue.startsWith(prefix));
      },
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }

  /**
   * Match values within any of the given ranges.
   */
  inAnyRange(
    ranges: [unknown, unknown][],
    options?: { includeLowers?: boolean; includeUppers?: boolean },
  ): Collection<T, TKey> {
    if (ranges.length === 0) {
      // Empty ranges - return empty collection
      const ctx: CollectionContext = {
        table: this.table,
        index: this.indexName,
        range: keyRangeAll(),
        filter: () => false,
        reverse: false,
        unique: false,
      };
      return new Collection(ctx, this.getTransaction);
    }

    const includeLowers = options?.includeLowers ?? true;
    const includeUppers = options?.includeUppers ?? false;

    // For a single range, use between
    if (ranges.length === 1) {
      const [range] = ranges;
      return this.between(
        (range as [unknown, unknown])[0],
        (range as [unknown, unknown])[1],
        includeLowers,
        includeUppers,
      );
    }

    // For multiple ranges, use filter with proper key comparison
    const ctx: CollectionContext = {
      table: this.table,
      index: this.indexName,
      range: keyRangeAll(),
      filter: (item: unknown) => {
        const value = this.getIndexValue(item);
        return ranges.some(([lower, upper]) => {
          // Use compareKeys for proper IndexedDB key ordering
          const cmpLower = compareKeys(value, lower);
          const cmpUpper = compareKeys(value, upper);
          const aboveLower = includeLowers ? cmpLower >= 0 : cmpLower > 0;
          const belowUpper = includeUppers ? cmpUpper <= 0 : cmpUpper < 0;
          return aboveLower && belowUpper;
        });
      },
      reverse: false,
      unique: false,
    };

    return new Collection(ctx, this.getTransaction);
  }
}
