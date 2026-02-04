# LessDB Specification

A minimal, extensible IndexedDB wrapper inspired by [Dexie.js](https://dexie.org/).

> **Attribution**: This library is heavily inspired by Dexie.js by David Fahlander. We've borrowed many API patterns and browser compatibility fixes from their excellent work. If you need a full-featured, battle-tested IndexedDB library, consider using Dexie.js directly.

## Design Goals

1. **Simple** - Core API covers 90% of use cases in ~1000 lines
2. **Dexie-Compatible** - API-compatible with Dexie.js for easy migration
3. **Extensible** - Hook points for middleware, reactivity, and sync
4. **Reliable** - Include Dexie's browser compatibility fixes
5. **Typed** - First-class TypeScript support

> **API Compatibility**: LessDB aims to be a drop-in replacement for Dexie.js for common use cases. Code written for Dexie should work with LessDB with minimal changes. We intentionally match Dexie's method names, signatures, and behaviors.

## Non-Goals (for v1)

- Live queries / reactivity (designed for, not implemented)
- Cloud sync (handled by external sync layer)
- Entity classes with methods
- Compound indexes (can add later)
- Multi-entry indexes (can add later)

---

## Core API

### Database Declaration

```typescript
import { LessDB } from "less-db";

// Define database with schema
const db = new LessDB("MyDatabase");

db.version(1).stores({
  friends: "++id, name, age", // auto-increment primary key
  settings: "key", // explicit primary key
  logs: "++, timestamp", // auto-increment, no key property
});

// Access tables (auto-generated from schema)
db.friends; // Table<Friend, number>
db.settings; // Table<Setting, string>

// Open explicitly (optional - auto-opens on first operation)
await db.open();

// Close
db.close();

// Delete entire database
await db.delete();
```

### Schema String Syntax

```
Format: '[keyPath], [index1], [index2], ...'

Primary Key Modifiers:
  ++        Auto-increment (++id or just ++)
  &         Unique constraint (&email)

Examples:
  '++id'              Auto-increment 'id' field
  '++'                Auto-increment, key not stored in object
  'id'                Explicit 'id' field as primary key
  '++id, name, age'   Primary key + two indexed fields
  '++id, &email'      Primary key + unique email index
```

### Table Operations

```typescript
interface Table<T, TKey> {
  // Single-item operations
  get(key: TKey): Promise<T | undefined>;
  add(item: T, key?: TKey): Promise<TKey>;
  put(item: T, key?: TKey): Promise<TKey>;
  update(key: TKey, changes: Partial<T>): Promise<number>;
  upsert(item: T | Partial<T>, key?: TKey): Promise<TKey>; // Add or update in one call
  delete(key: TKey): Promise<void>;

  // Bulk operations
  bulkGet(keys: TKey[]): Promise<(T | undefined)[]>;
  bulkAdd(items: T[], keys?: TKey[]): Promise<TKey[]>;
  bulkPut(items: T[], keys?: TKey[]): Promise<TKey[]>;
  bulkUpdate(keysAndChanges: { key: TKey; changes: Partial<T> }[]): Promise<number>;
  bulkDelete(keys: TKey[]): Promise<void>;

  // Full table operations
  clear(): Promise<void>;
  count(): Promise<number>;
  toArray(): Promise<T[]>;

  // Query entry points
  where(indexName: string): WhereClause<T, TKey>;
  filter(fn: (item: T) => boolean): Collection<T, TKey>;
  orderBy(indexName: string): Collection<T, TKey>;

  // Direct collection access
  toCollection(): Collection<T, TKey>;

  // Schema info
  readonly name: string;
  readonly schema: TableSchema;

  // Hook points (for middleware)
  readonly hook: TableHooks<T, TKey>;
}
```

### WhereClause (Index Queries)

```typescript
interface WhereClause<T, TKey> {
  // Equality
  equals(value: any): Collection<T, TKey>;
  equalsIgnoreCase(value: string): Collection<T, TKey>;
  notEqual(value: any): Collection<T, TKey>;
  anyOf(values: any[]): Collection<T, TKey>;
  anyOfIgnoreCase(values: string[]): Collection<T, TKey>;
  noneOf(values: any[]): Collection<T, TKey>;

  // Ranges
  above(value: any): Collection<T, TKey>;
  aboveOrEqual(value: any): Collection<T, TKey>;
  below(value: any): Collection<T, TKey>;
  belowOrEqual(value: any): Collection<T, TKey>;
  between(
    lower: any,
    upper: any,
    includeLower?: boolean,
    includeUpper?: boolean,
  ): Collection<T, TKey>;
  inAnyRange(
    ranges: [any, any][],
    options?: { includeLowers?: boolean; includeUppers?: boolean },
  ): Collection<T, TKey>;

  // String operations
  startsWith(prefix: string): Collection<T, TKey>;
  startsWithIgnoreCase(prefix: string): Collection<T, TKey>;
  startsWithAnyOf(prefixes: string[]): Collection<T, TKey>;
  startsWithAnyOfIgnoreCase(prefixes: string[]): Collection<T, TKey>;
}
```

### Collection (Query Results)

```typescript
interface Collection<T, TKey> {
  // Filtering (returns new Collection)
  and(fn: (item: T) => boolean): Collection<T, TKey>;
  filter(fn: (item: T) => boolean): Collection<T, TKey>;
  or(indexName: string): WhereClause<T, TKey>; // Combine with OR logic

  // Pagination
  limit(count: number): Collection<T, TKey>;
  offset(count: number): Collection<T, TKey>;
  until(predicate: (item: T) => boolean, includeStopItem?: boolean): Collection<T, TKey>;

  // Ordering
  reverse(): Collection<T, TKey>;
  desc(): Collection<T, TKey>; // Alias for reverse()

  // Cloning
  clone(): Collection<T, TKey>;

  // Terminal operations (execute query)
  toArray(): Promise<T[]>;
  first(): Promise<T | undefined>;
  last(): Promise<T | undefined>;
  count(): Promise<number>;
  keys(): Promise<TKey[]>;
  primaryKeys(): Promise<TKey[]>;
  eachKey(callback: (key: TKey) => void): Promise<void>;
  eachPrimaryKey(callback: (key: TKey) => void): Promise<void>;
  firstKey(): Promise<TKey | undefined>;
  lastKey(): Promise<TKey | undefined>;

  // Iteration
  each(callback: (item: T) => void): Promise<void>;

  // Mutation
  modify(changes: Partial<T> | ((item: T) => void)): Promise<number>;
  delete(): Promise<number>;

  // Sorting (non-indexed, loads all into memory)
  sortBy(keyPath: string): Promise<T[]>;

  // Advanced
  raw(): Collection<T, TKey>; // Skip reading hooks
}
```

### Transactions

```typescript
// Explicit transaction
await db.transaction("rw", [db.friends, db.logs], async (tx) => {
  const id = await tx.friends.add({ name: "Alice", age: 30 });
  await tx.logs.add({ action: "created", friendId: id, timestamp: Date.now() });
  return id;
});

// Transaction modes
type TransactionMode = "r" | "readonly" | "rw" | "readwrite";

// Transaction interface
interface Transaction {
  readonly mode: TransactionMode;
  readonly tables: string[];
  abort(): void;

  // Table access within transaction
  table<T, TKey>(name: string): Table<T, TKey>;
}
```

### Versioning & Migrations

```typescript
db.version(1).stores({
  friends: "++id, name",
});

db.version(2)
  .stores({
    friends: "++id, name, email", // Added email index
  })
  .upgrade(async (tx) => {
    // Migration logic
    await tx.friends.toCollection().modify((friend) => {
      friend.email = friend.email || "unknown@example.com";
    });
  });

db.version(3).stores({
  friends: "++id, name, email",
  settings: "key", // New table
});
```

---

## Extensibility Architecture

### Middleware System

Middleware wraps the core database operations, enabling features like:

- Reactivity / live queries
- Encryption
- Sync tracking
- Logging / debugging

```typescript
interface Middleware {
  stack: "dbcore"; // Required - identifies this as a DBCore middleware
  name?: string; // Optional name for debugging
  level?: number; // Execution order (lower = closer to IndexedDB)

  // Wrap the DBCore layer - returns partial override
  create(downCore: DBCore): Partial<DBCore>;
}

// Register middleware
db.use(myMiddleware);

// DBCore interface (internal, but exposed for middleware)
interface DBCore {
  stack: "dbcore";
  schema: DBCoreSchema;
  transaction(tables: string[], mode: TransactionMode): DBCoreTransaction;
  table(name: string): DBCoreTable;
}

// Transaction interface - middleware can attach custom properties
interface DBCoreTransaction {
  abort(): void;
  // Middleware can add custom properties, e.g.:
  // __syncOrigin?: 'local' | 'remote';
  // __changeTracking?: ChangeRecord[];
}

// All request objects include the transaction (Dexie pattern)
interface DBCoreTable {
  name: string;
  schema: DBCoreTableSchema;

  get(req: { trans: DBCoreTransaction; key: any }): Promise<any>;
  getMany(req: { trans: DBCoreTransaction; keys: any[] }): Promise<any[]>;
  query(req: DBCoreQueryRequest): Promise<DBCoreQueryResponse>;
  count(req: DBCoreCountRequest): Promise<number>;
  mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse>;
  openCursor(req: DBCoreOpenCursorRequest): Promise<DBCoreCursor | null>;
}

// Mutate request supports add, put, delete, and deleteRange
interface DBCoreMutateRequest {
  trans: DBCoreTransaction;
  type: "add" | "put" | "delete" | "deleteRange";
  values?: readonly unknown[]; // For add/put
  keys?: unknown[]; // For add/put/delete
  range?: DBCoreKeyRange; // For deleteRange
}
```

#### Middleware Chaining

Middleware forms a chain where each layer can intercept and modify operations:

```typescript
// Example: Sync tracking middleware
const syncMiddleware: Middleware = {
  stack: "dbcore",
  name: "sync-tracker",
  level: 1, // Close to IndexedDB

  create(downCore: DBCore): Partial<DBCore> {
    return {
      table: (name: string): DBCoreTable => {
        const downTable = downCore.table(name);
        return {
          ...downTable,
          mutate: async (req) => {
            // Check if this is a remote sync operation
            const isRemote = (req.trans as any).__syncOrigin === "remote";

            if (!isRemote) {
              // Track local changes for sync
              trackLocalChange(name, req);
            }

            return downTable.mutate(req);
          },
        };
      },
    };
  },
};

// Usage: Mark transaction as remote sync
await db.transaction("rw", ["users"], async (tx) => {
  (tx as any).__syncOrigin = "remote";
  await tx.table("users").bulkPut(remoteChanges);
});
```

### Table Hooks

For simpler extension needs (validation, timestamps, etc.):

```typescript
interface TableHooks<T, TKey> {
  creating: Hook<(key: TKey, obj: T, trans: Transaction) => void>;
  reading: Hook<(obj: T) => T | void>;
  updating: Hook<(changes: Partial<T>, key: TKey, obj: T, trans: Transaction) => void>;
  deleting: Hook<(key: TKey, obj: T, trans: Transaction) => void>;
}

// Usage
db.friends.hook.creating.subscribe((key, obj, trans) => {
  obj.createdAt = Date.now();
});

db.friends.hook.reading.subscribe((obj) => {
  // Transform on read
  return { ...obj, fullName: `${obj.firstName} ${obj.lastName}` };
});
```

### Events

```typescript
interface DatabaseEvents {
  // Database lifecycle
  ready: Event<() => void>;
  blocked: Event<(event: IDBVersionChangeEvent) => void>;
  versionchange: Event<(event: IDBVersionChangeEvent) => void>;
  close: Event<() => void>;

  // For future reactivity
  changes: Event<(changes: DatabaseChange[]) => void>;
}

interface DatabaseChange {
  table: string;
  type: "add" | "put" | "delete";
  key: any;
  obj?: any;
  oldObj?: any;
}

// Usage
db.on("ready", () => console.log("Database ready"));
db.on("changes", (changes) => {
  // React to changes (for sync, reactivity, etc.)
});
```

---

## IndexedDB 3.0 Features

LessDB leverages modern IndexedDB 3.0 features where supported for optimal performance.

### Transaction Durability

IndexedDB 3.0 introduces durability hints for transactions:

```typescript
// Default: Let browser decide
await db.transaction("rw", ["users"], fn);

// Relaxed: Faster, may lose data on crash (good for logs, caches)
await db.transaction("rw", ["logs"], fn, { durability: "relaxed" });

// Strict: Wait for data to be flushed to disk
await db.transaction("rw", ["critical"], fn, { durability: "strict" });
```

**Values**:

- `'default'` - Browser decides (Chrome defaults to relaxed since v121)
- `'relaxed'` - Commit after OS write buffer (faster)
- `'strict'` - Wait for physical disk write (safer)

**Browser support**: Chrome 83+, Firefox 126+, Safari 15.4+

### Explicit Commit

Use `transaction.commit()` to begin commit immediately:

```typescript
await db.transaction("rw", ["users"], async (tx) => {
  await tx.table("users").bulkAdd(users);
  tx.commit(); // Start commit without waiting for request completion
});
```

**Browser support**: Chrome 76+, Firefox 74+, Safari 15+

### Key Cursors

For queries that only need keys (not values), LessDB uses `openKeyCursor()` instead of `openCursor()` to avoid loading record data from disk:

```typescript
// Uses openKeyCursor() internally - faster than loading full records
const keys = await db.users.where("age").above(30).primaryKeys();
```

**Browser support**: Chrome 23+, Firefox 44+, Safari 10.1+

### Unique Cursor Directions

For queries with `unique: true`, LessDB uses native `'nextunique'`/`'prevunique'` cursor directions to deduplicate at the engine level rather than in JavaScript.

**Browser support**: All modern browsers

---

## Browser Compatibility

### Required Polyfills

LessDB handles these internally:

| Issue                        | Browser               | Fix                                                    |
| ---------------------------- | --------------------- | ------------------------------------------------------ |
| Vendor prefixes              | Old Safari/Firefox/IE | Check `mozIndexedDB`, `webkitIndexedDB`, `msIndexedDB` |
| Safari 8 multi-store bug     | Safari 8              | `safariMultiStoreFix()` - reduce store names           |
| Safari 8 version overflow    | Safari 8              | Treat `oldVersion > 2^62` as 0                         |
| Safari 14 IDB bug            | Safari 14             | Use `safari-14-idb-fix`                                |
| Safari getAll() bug          | Safari < 604          | Fall back to cursor iteration                          |
| Safari private mode          | Safari                | Handle null from `indexedDB.open()`                    |
| Safari instanceof            | Safari                | Use `Object.prototype.toString` for type checks        |
| Chrome UnknownError          | Chrome                | Retry open() up to 3 times after site data clear       |
| IE/Edge/Safari versionchange | IE, Edge, Safari      | Emulate via connection tracking                        |
| Back/forward cache           | All modern            | Close/reopen on `pagehide`/`pageshow`                  |
| Undefined primary key        | All                   | Remove undefined key property before add               |
| Max key differences          | All                   | Detect `[[]]` vs max string support                    |

### Implementation

```typescript
// src/compat/index.ts

export const indexedDB =
  globalThis.indexedDB ||
  globalThis.mozIndexedDB ||
  globalThis.webkitIndexedDB ||
  globalThis.msIndexedDB;

export const IDBKeyRange = globalThis.IDBKeyRange || globalThis.webkitIDBKeyRange;

// Safari 8 multi-store fix
export function safariMultiStoreFix(storeNames: string[]): string | string[] {
  return storeNames.length === 1 ? storeNames[0] : storeNames;
}

// Safari 8 version fix
export function fixOldVersion(oldVersion: number): number {
  return oldVersion > Math.pow(2, 62) ? 0 : oldVersion;
}

// Safari getAll detection
export function hasWorkingGetAll(db: IDBDatabase): boolean {
  if (typeof navigator === "undefined") return true;
  if (!/Safari/.test(navigator.userAgent)) return true;
  if (/(Chrome\/|Edge\/)/.test(navigator.userAgent)) return true;
  const match = navigator.userAgent.match(/Safari\/(\d*)/);
  return match ? parseInt(match[1], 10) >= 604 : true;
}

// Max key detection
let maxKey: any;
export function getMaxKey(): any {
  if (maxKey !== undefined) return maxKey;
  try {
    IDBKeyRange.only([[]]);
    maxKey = [[]];
  } catch {
    maxKey = String.fromCharCode(65535); // Max string
  }
  return maxKey;
}

// Safari type checking (instanceof unreliable)
export function getType(value: any): string {
  const t = typeof value;
  if (t !== "object") return t;
  if (value === null) return "null";
  if (ArrayBuffer.isView(value)) return "binary";
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === "ArrayBuffer" ? "binary" : tag.toLowerCase();
}

// Undefined primary key workaround
export function fixUndefinedKey<T>(obj: T, keyPath: string): T {
  if (typeof keyPath !== "string" || keyPath.includes(".")) return obj;
  if (obj[keyPath] === undefined && keyPath in obj) {
    const clone = { ...obj };
    delete clone[keyPath];
    return clone;
  }
  return obj;
}

// bfcache support
export function setupBfCacheHandling(db: LessDB): void {
  if (typeof addEventListener === "undefined") return;

  addEventListener("pagehide", (event) => {
    if ((event as PageTransitionEvent).persisted) {
      db.close({ disableAutoOpen: false });
    }
  });

  addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) {
      db._requery(); // Trigger observers to re-fetch
    }
  });
}
```

---

## Internal Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Public API                         │
│  (LessDB, Table, Collection, WhereClause, Transaction)  │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                     Middleware Stack                    │
│            (Hooks, Cache, Logging/Observability)        │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                        DBCore                           │
│            (Abstract database operations)               │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                   IndexedDB Adapter                     │
│         (Browser compat, actual IDB calls)              │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  Native IndexedDB                       │
└─────────────────────────────────────────────────────────┘
```

### File Structure

```
src/
├── index.ts                 # Public exports
├── less-db.ts               # Main LessDB class
├── table.ts                 # Table class
├── collection.ts            # Collection class
├── where-clause.ts          # WhereClause class
├── transaction.ts           # Transaction class
├── version.ts               # Version/schema management
├── schema-parser.ts         # Parse '++id, name' syntax
├──
├── dbcore/
│   ├── types.ts             # DBCore interfaces
│   ├── dbcore.ts            # DBCore implementation
│   └── indexeddb-adapter.ts # IDB driver with compat fixes
├──
├── compat/
│   ├── index.ts             # Browser compatibility utilities
│   └── safari-14-fix.ts     # Safari 14 workaround
├──
├── middleware/
│   ├── types.ts             # Middleware interfaces
│   └── hooks.ts             # Table hooks middleware
├──
├── events/
│   └── events.ts            # Event emitter
├──
└── errors/
    └── errors.ts            # Error classes (ConstraintError, etc.)
```

---

## Performance Characteristics

### Query Strategy: getAll vs Cursors

LessDB uses different strategies for different query types, optimizing for the common case of small-to-medium datasets (under 100,000 records per table).

**Index-based queries** (`where().equals()`, `where().above()`, etc.):

- Use IndexedDB's native key range queries
- Efficient for any dataset size
- Results limited by index selectivity

**In-memory filtering queries** (`filter()`, `notEqual()`, `noneOf()`):

- Use `getAll()` to fetch all records, then filter in JavaScript
- Significantly faster than cursor iteration for most datasets
- Trade memory for speed

### Memory vs Speed Tradeoffs

The following operations load all matching records into memory before filtering:

| Operation                | Strategy              | Performance                  | Memory                    |
| ------------------------ | --------------------- | ---------------------------- | ------------------------- |
| `table.filter(fn)`       | getAll + Array.filter | 10-20x faster than cursors   | O(n) where n = table size |
| `where(idx).notEqual(v)` | getAll + filter       | 10-20x faster than cursors   | O(n) where n = table size |
| `where(idx).noneOf(arr)` | getAll + filter       | 100-200x faster than cursors | O(n) where n = table size |
| `where(idx).equals(v)`   | IDB key range         | Native speed                 | O(m) where m = matches    |
| `where(idx).anyOf(arr)`  | Parallel IDB queries  | Native speed                 | O(m) where m = matches    |

**Why this approach?**

Modern JavaScript engines optimize `getAll()` + `Array.filter()` extremely well:

- Single IndexedDB round-trip (vs one per cursor advance)
- V8/SpiderMonkey JIT-optimize array iteration
- No async overhead per record
- Memory allocation is batched

Cursor-based iteration has inherent overhead:

- Each `cursor.continue()` is an async operation
- Cannot be JIT-optimized across await boundaries
- IndexedDB transaction management per step

### When to Consider Alternatives

For very large tables (100,000+ records), the in-memory approach may cause:

- **Memory pressure**: Loading 100k records into memory before filtering
- **Initial latency**: Time to fetch all records before first result

**Recommendations for large datasets:**

1. **Use indexed queries when possible**: `where('status').equals('active')` is always O(matches), not O(table size)

2. **Combine index + filter**: Narrow with an index first, then filter:

   ```typescript
   // Better: uses index to narrow, then filters small result
   await db.users
     .where("status")
     .equals("active")
     .filter((u) => u.age > 30)
     .toArray();

   // Worse: loads all users into memory
   await db.users.filter((u) => u.status === "active" && u.age > 30).toArray();
   ```

3. **Add indexes for frequent queries**: If you often filter by a field, add an index for it

4. **Pagination**: Use `limit()` and `offset()` to process in batches:
   ```typescript
   const pageSize = 1000;
   let offset = 0;
   while (true) {
     const batch = await db.users.filter(fn).offset(offset).limit(pageSize).toArray();
     if (batch.length === 0) break;
     processBatch(batch);
     offset += pageSize;
   }
   ```

### Benchmark Context

In benchmarks against Dexie.js, LessDB shows significant performance gains for filter operations due to this strategy. The tradeoff is intentional: most applications have tables with hundreds to thousands of records, where memory is not a concern but query latency is noticeable.

If your use case involves very large tables with frequent full-table scans, consider:

- Adding appropriate indexes
- Using server-side filtering for large datasets
- Implementing custom cursor-based iteration for specific queries

---

## Error Handling

```typescript
// Error classes (match Dexie for compatibility)
class LessDBError extends Error {
  constructor(
    message: string,
    public inner?: Error,
  ) {
    super(message);
    this.name = "LessDBError";
  }
}

class ConstraintError extends LessDBError {
  name = "ConstraintError";
}
class NotFoundError extends LessDBError {
  name = "NotFoundError";
}
class InvalidStateError extends LessDBError {
  name = "InvalidStateError";
}
class InvalidTableError extends LessDBError {
  name = "InvalidTableError";
}
class DataError extends LessDBError {
  name = "DataError";
}
class AbortError extends LessDBError {
  name = "AbortError";
}

// Typed catch
db.friends
  .add(friend)
  .catch(ConstraintError, (err) => {
    console.log("Duplicate key");
  })
  .catch((err) => {
    console.log("Other error:", err);
  });
```

---

## Dexie Alignment Patterns

This section documents key Dexie.js patterns that LessDB should implement for full compatibility. These patterns have been battle-tested in Dexie across millions of applications.

### Transaction Management

#### Implicit Transactions (Not Yet Implemented)

Dexie automatically creates a transaction for single operations when no explicit transaction exists:

```typescript
// In Dexie, this auto-creates a readonly transaction:
const user = await db.users.get(1);

// This auto-creates a readwrite transaction:
await db.users.add({ name: "Alice" });

// LessDB currently requires: await db.open() first, then operations
// use implicit single-operation transactions internally
```

**Implementation approach**: Wrap table operations to detect if running inside a transaction context. If not, create an implicit single-operation transaction.

#### PSD (Promise-Specific Data) Pattern (Not Yet Implemented)

Dexie uses "Promise-Specific Data" to track transaction context across async boundaries. This allows nested function calls to automatically reuse the parent transaction.

```typescript
// Dexie's PSD allows this to work:
async function addUserWithProfile(userData, profileData) {
  // These automatically use the same transaction if called within one
  const userId = await db.users.add(userData);
  await db.profiles.add({ ...profileData, userId });
  return userId;
}

// Called within explicit transaction - both ops use same transaction
await db.transaction("rw", ["users", "profiles"], async () => {
  await addUserWithProfile({ name: "Alice" }, { bio: "Hello" });
});

// Called outside transaction - each op gets its own implicit transaction
await addUserWithProfile({ name: "Bob" }, { bio: "World" });
```

**Dexie's implementation** (`src/helpers/promise.js`):

- Uses Zone.js-like pattern with a global `PSD` (Promise-Specific Data) object
- Wraps Promise to propagate PSD through `.then()` chains
- Stores current transaction in `PSD.trans`
- Functions can access `PSD.trans` to get the ambient transaction

**Implementation options for LessDB**:

1. **AsyncLocalStorage** (Node.js) - Use `AsyncLocalStorage` for server-side
2. **Zone.js pattern** - Wrap Promise prototype (invasive but compatible)
3. **Explicit context** - Require passing transaction context (less ergonomic)

#### Nested Transaction Reuse

When code requests a transaction on tables already covered by a parent transaction, Dexie reuses the parent:

```typescript
await db.transaction("rw", ["users", "posts"], async () => {
  // This nested transaction reuses the parent (same tables, compatible mode)
  await db.transaction("r", ["users"], async () => {
    const user = await db.users.get(1);
  });
});
```

**Rules from Dexie**:

- Nested transaction must request subset of parent's tables
- Nested mode must be compatible (readonly can nest in readwrite)
- If incompatible, Dexie either throws or waits (configurable)

#### Blocked Function Queue

When a transaction can't start immediately (e.g., waiting for another transaction), Dexie queues the operation instead of failing:

```typescript
// In Dexie, these can run concurrently without explicit coordination
const promise1 = db.transaction("rw", ["users"], async () => {
  /* ... */
});
const promise2 = db.transaction("rw", ["users"], async () => {
  /* ... */
});
// promise2 waits for promise1 to complete
```

### Error Handling Patterns

#### Error Type Hierarchy

Dexie provides a rich error hierarchy for precise error handling:

```typescript
// Dexie's error types (from src/errors/index.js)
class DexieError extends Error {
  name: string;
  inner?: Error; // Original error
}

// Specific error types
class AbortError extends DexieError {} // Transaction aborted
class ConstraintError extends DexieError {} // Unique constraint violation
class DataError extends DexieError {} // Invalid data for IndexedDB
class DatabaseClosedError extends DexieError {} // DB was closed
class InternalError extends DexieError {} // Internal error
class InvalidAccessError extends DexieError {} // Access violation
class InvalidArgumentError extends DexieError {} // Bad argument
class InvalidStateError extends DexieError {} // Invalid state
class InvalidTableError extends DexieError {} // Table doesn't exist
class MissingAPIError extends DexieError {} // IndexedDB not available
class NoSuchDatabaseError extends DexieError {} // Database doesn't exist
class NotFoundError extends DexieError {} // Record not found
class OpenFailedError extends DexieError {} // Failed to open database
class PrematureCommitError extends DexieError {} // Transaction committed early
class QuotaExceededError extends DexieError {} // Storage quota exceeded
class ReadOnlyError extends DexieError {} // Write in readonly transaction
class SchemaError extends DexieError {} // Schema definition error
class SubTransactionError extends DexieError {} // Nested transaction error
class TimeoutError extends DexieError {} // Operation timeout
class TransactionInactiveError extends DexieError {} // Transaction no longer active
class UnknownError extends DexieError {} // Unknown error
class UnsupportedError extends DexieError {} // Unsupported operation
class UpgradeError extends DexieError {} // Version upgrade failed
class VersionChangeError extends DexieError {} // Version change error
class VersionError extends DexieError {} // Version mismatch
```

#### Type-Based Error Catching (Not Yet Implemented)

Dexie extends Promise with type-based `.catch()`:

```typescript
// Dexie's type-based catch
await db.users
  .add({ id: 1, name: "Alice" })
  .catch(Dexie.ConstraintError, (err) => {
    // Handle duplicate key specifically
    console.log("User already exists");
  })
  .catch(Dexie.QuotaExceededError, (err) => {
    // Handle storage full
    console.log("Storage quota exceeded");
  })
  .catch((err) => {
    // Handle all other errors
    console.log("Unexpected error:", err);
  });
```

**Implementation approach**: Create a custom Promise subclass or wrapper that adds type-based catch:

```typescript
class LessDBPromise<T> extends Promise<T> {
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult>;
  catch<E extends Error, TResult = never>(
    ErrorType: new (...args: any[]) => E,
    onrejected: (error: E) => TResult | PromiseLike<TResult>,
  ): LessDBPromise<T | TResult>;
}
```

#### Error Mapping

Dexie maps IndexedDB's DOMException errors to semantic error types:

```typescript
// Dexie's error mapping (simplified from src/errors/index.js)
function mapError(domError: DOMException): DexieError {
  switch (domError.name) {
    case "ConstraintError":
      return new ConstraintError(domError.message, domError);
    case "QuotaExceededError":
      return new QuotaExceededError(domError.message, domError);
    case "DataError":
      return new DataError(domError.message, domError);
    // ... etc
  }
}
```

### Hooks as Middleware (Not Yet Implemented)

Dexie implements table hooks as internal middleware, which provides several benefits:

1. **Consistent interception point** - All operations go through middleware
2. **Composable** - Multiple hooks stack naturally
3. **Cancellable** - Hooks can prevent operations

**Current LessDB approach**: Hooks are called directly in Table methods
**Dexie approach**: Hooks are middleware that wraps DBCore operations

```typescript
// Dexie's hooks middleware pattern (conceptual)
const hooksMiddleware: Middleware = {
  stack: "dbcore",
  name: "hooks",
  level: 0, // Outermost layer

  create(downCore: DBCore): Partial<DBCore> {
    return {
      table: (name: string) => {
        const downTable = downCore.table(name);
        const hooks = getHooksForTable(name);

        return {
          ...downTable,
          mutate: async (req) => {
            // Fire creating/updating/deleting hooks
            if (req.type === "add") {
              for (const value of req.values) {
                hooks.creating.fire(undefined, value, req.trans);
              }
            }
            return downTable.mutate(req);
          },
          get: async (req) => {
            const result = await downTable.get(req);
            // Fire reading hook
            return hooks.reading.fire(result);
          },
        };
      },
    };
  },
};
```

### Cache Middleware Pattern

Dexie provides optional caching via middleware:

```typescript
// Dexie's cache middleware concept
const cacheMiddleware: Middleware = {
  stack: "dbcore",
  name: "cache",

  create(downCore: DBCore): Partial<DBCore> {
    const cache = new Map<string, Map<any, any>>(); // table -> key -> value

    return {
      table: (name: string) => {
        const downTable = downCore.table(name);
        const tableCache = cache.get(name) ?? new Map();
        cache.set(name, tableCache);

        return {
          ...downTable,
          get: async (req) => {
            if (tableCache.has(req.key)) {
              return tableCache.get(req.key);
            }
            const result = await downTable.get(req);
            tableCache.set(req.key, result);
            return result;
          },
          mutate: async (req) => {
            // Invalidate cache on mutations
            if (req.type === "add" || req.type === "put") {
              req.keys?.forEach((k) => tableCache.delete(k));
            } else if (req.type === "delete") {
              req.keys?.forEach((k) => tableCache.delete(k));
            } else if (req.type === "deleteRange") {
              tableCache.clear(); // Conservative: clear all
            }
            return downTable.mutate(req);
          },
        };
      },
    };
  },
};
```

### Live Query Pattern (Future)

Dexie's `liveQuery` observes database changes and re-runs queries:

```typescript
// Dexie's liveQuery API
import { liveQuery } from "dexie";

const observable = liveQuery(() => db.users.where("age").above(18).toArray());

observable.subscribe({
  next: (users) => console.log("Users updated:", users),
  error: (err) => console.error("Query error:", err),
});
```

**Implementation components**:

1. **Query tracking** - Record which tables/ranges a query reads
2. **Change detection** - Middleware emits change events on mutations
3. **Selective re-query** - Only re-run queries affected by changes
4. **Subscription management** - Handle subscribe/unsubscribe lifecycle

---

## Future Extensions (Designed For)

### Live Queries (Reactivity)

```typescript
// Future API
import { liveQuery } from "less-db";

const friends$ = liveQuery(() => db.friends.where("age").below(30).toArray());

friends$.subscribe((friends) => {
  console.log("Friends updated:", friends);
});
```

Implementation via middleware that:

1. Tracks which tables/ranges are read during query
2. Listens to `changes` event
3. Re-runs query when relevant changes occur

### Encryption Middleware

```typescript
// Future API
import { encryptionMiddleware } from "less-db-encryption";

db.use(
  encryptionMiddleware({
    key: myEncryptionKey,
    tables: {
      friends: ["name", "email"], // Encrypt these fields
      secrets: true, // Encrypt entire objects
    },
  }),
);
```

### Sync Tracking Middleware

```typescript
// Future API
import { syncMiddleware } from "less-db-sync";

db.use(
  syncMiddleware({
    onLocalChange: (change) => {
      // Queue for sync
    },
    getRemoteChanges: async (since) => {
      // Fetch from server
    },
  }),
);
```

---

## Implementation Priorities

### Phase 1: Core (MVP) ✅

- [x] Schema parsing
- [x] LessDB class with version/stores
- [x] Table with basic CRUD
- [x] Simple Collection (filter, toArray, count)
- [x] Basic transaction support
- [x] Browser compatibility layer
- [x] Error classes

### Phase 2: Query Power ✅

- [x] WhereClause with all range methods
- [x] Collection chaining (and, limit, offset, reverse)
- [x] Bulk operations
- [x] orderBy / sortBy

### Phase 2b: Additional Dexie Compatibility ✅

- [x] Table.upsert() / bulkUpdate()
- [x] WhereClause.anyOfIgnoreCase() / startsWithAnyOf() / inAnyRange()
- [x] Collection.or() / until() / clone() / desc() / raw()
- [x] Collection.firstKey() / lastKey() / eachKey() / eachPrimaryKey()

### Phase 3: Extensibility ✅

- [x] Middleware system (db.use() / db.unuse())
- [x] Table hooks
- [x] Events (changes, ready, etc.)
- [x] bfcache handling (setupBfCacheHandling())

### Phase 4: Dexie Deep Alignment 🚧

These patterns are critical for matching Dexie's behavior and enabling advanced use cases like sync:

#### High Priority

- [ ] **Implicit transactions** - Auto-create transaction for single operations outside explicit transaction
- [ ] **PSD (Promise-Specific Data)** - Track transaction context across async boundaries
- [ ] **Expanded error types** - Add all Dexie error types (QuotaExceededError, TimeoutError, etc.)
- [x] **Type-based error catching** - `promise.catch(ConstraintError, handler)` pattern
- [ ] **Error mapping** - Map IndexedDB DOMException to semantic error types

#### Medium Priority

- [x] **Hooks as middleware** - Implement hooks via DBCore middleware layer
- [x] **Cache middleware** - Optional per-table caching middleware
- [ ] **Nested transaction reuse** - Reuse parent transaction when tables are subset
- [ ] **Recursive locking** - Allow nested operations on same tables within transaction
- [ ] **Blocked function queue** - Queue operations waiting for transaction access

#### Lower Priority

- [ ] **Live query foundation** - Query tracking and change detection for observables
- [x] **Observability middleware** - Standard middleware for logging/debugging
- [ ] **VIP promise pattern** - Priority handling for internal operations

### Phase 5: Polish

- [x] Full TypeScript generics
- [x] Comprehensive tests (746 tests)
- [ ] Documentation
- [ ] Performance optimization

---

## API Compatibility with Dexie

**Goal**: LessDB should be a drop-in replacement for Dexie.js in common use cases. Migrating from Dexie to LessDB should require minimal code changes.

### Compatibility Matrix

| Feature                                                        | LessDB | Dexie | Notes                        |
| -------------------------------------------------------------- | ------ | ----- | ---------------------------- |
| `new DB(name)`                                                 | ✅     | ✅    | Identical                    |
| `db.version(n).stores({})`                                     | ✅     | ✅    | Identical                    |
| `db.table.get/add/put/update/delete`                           | ✅     | ✅    | Identical                    |
| `db.table.upsert()`                                            | ✅     | ✅    | Identical                    |
| `db.table.bulkGet/bulkAdd/bulkPut/bulkDelete`                  | ✅     | ✅    | Identical                    |
| `db.table.bulkUpdate()`                                        | ✅     | ✅    | Identical                    |
| `db.table.where().equals/equalsIgnoreCase()`                   | ✅     | ✅    | Identical                    |
| `db.table.where().above/below/between()`                       | ✅     | ✅    | Identical                    |
| `db.table.where().anyOf/anyOfIgnoreCase/noneOf()`              | ✅     | ✅    | Identical                    |
| `db.table.where().inAnyRange()`                                | ✅     | ✅    | Identical                    |
| `db.table.where().startsWith/startsWithIgnoreCase()`           | ✅     | ✅    | Identical                    |
| `db.table.where().startsWithAnyOf/startsWithAnyOfIgnoreCase()` | ✅     | ✅    | Identical                    |
| `collection.filter().limit().offset()`                         | ✅     | ✅    | Identical                    |
| `collection.or()`                                              | ✅     | ✅    | Identical                    |
| `collection.until()`                                           | ✅     | ✅    | Identical                    |
| `collection.clone()`                                           | ✅     | ✅    | Identical                    |
| `collection.first/last/count/toArray()`                        | ✅     | ✅    | Identical                    |
| `collection.firstKey/lastKey/eachKey/eachPrimaryKey()`         | ✅     | ✅    | Identical                    |
| `collection.modify/delete()`                                   | ✅     | ✅    | Identical                    |
| `collection.raw()`                                             | ✅     | ✅    | Identical                    |
| `db.transaction('rw', [...], fn)`                              | ✅     | ✅    | Identical                    |
| `db.table.hook.creating/reading/etc`                           | ✅     | ✅    | Identical                    |
| `db.on('ready'/'close'/etc)`                                   | ✅     | ✅    | Identical                    |
| `db.use(middleware)`                                           | ✅     | ✅    | Identical                    |
| `liveQuery()`                                                  | ❌     | ✅    | Not planned for v1           |
| Compound indexes `[a+b]`                                       | ❌     | ✅    | Not planned for v1           |
| Multi-entry indexes `*tags`                                    | ❌     | ✅    | Not planned for v1           |
| Entity classes / `mapToClass()`                                | ❌     | ✅    | Not planned                  |
| `collection.distinct/uniqueKeys/eachUniqueKey()`               | ❌     | ✅    | Requires multi-entry indexes |

### Migration from Dexie

```typescript
// Before (Dexie)
import Dexie from "dexie";
const db = new Dexie("MyApp");

// After (LessDB)
import { LessDB } from "less-db";
const db = new LessDB("MyApp");

// Everything else stays the same!
```

---

## References

- [Dexie.js Source](https://github.com/dexie/Dexie.js)
- [IndexedDB Spec](https://www.w3.org/TR/IndexedDB/)
- [Safari 14 IDB Fix](https://github.com/nicopolacchi/safari-14-idb-fix)
- [MDN IndexedDB Guide](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
