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
import { LessDB } from 'less-db';

// Define database with schema
const db = new LessDB('MyDatabase');

db.version(1).stores({
  friends: '++id, name, age',      // auto-increment primary key
  settings: 'key',                  // explicit primary key
  logs: '++, timestamp'             // auto-increment, no key property
});

// Access tables (auto-generated from schema)
db.friends  // Table<Friend, number>
db.settings // Table<Setting, string>

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
  upsert(item: T | Partial<T>, key?: TKey): Promise<TKey>;  // Add or update in one call
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
  between(lower: any, upper: any, includeLower?: boolean, includeUpper?: boolean): Collection<T, TKey>;
  inAnyRange(ranges: [any, any][], options?: { includeLowers?: boolean; includeUppers?: boolean }): Collection<T, TKey>;

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
  or(indexName: string): WhereClause<T, TKey>;  // Combine with OR logic

  // Pagination
  limit(count: number): Collection<T, TKey>;
  offset(count: number): Collection<T, TKey>;
  until(predicate: (item: T) => boolean, includeStopItem?: boolean): Collection<T, TKey>;

  // Ordering
  reverse(): Collection<T, TKey>;
  desc(): Collection<T, TKey>;  // Alias for reverse()

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
  raw(): Collection<T, TKey>;  // Skip reading hooks
}
```

### Transactions

```typescript
// Explicit transaction
await db.transaction('rw', [db.friends, db.logs], async (tx) => {
  const id = await tx.friends.add({ name: 'Alice', age: 30 });
  await tx.logs.add({ action: 'created', friendId: id, timestamp: Date.now() });
  return id;
});

// Transaction modes
type TransactionMode = 'r' | 'readonly' | 'rw' | 'readwrite';

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
  friends: '++id, name'
});

db.version(2).stores({
  friends: '++id, name, email'  // Added email index
}).upgrade(async (tx) => {
  // Migration logic
  await tx.friends.toCollection().modify(friend => {
    friend.email = friend.email || 'unknown@example.com';
  });
});

db.version(3).stores({
  friends: '++id, name, email',
  settings: 'key'  // New table
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
  name: string;
  level?: number;  // Execution order (lower = closer to IndexedDB)

  // Wrap the DBCore layer
  create(downCore: DBCore): DBCore;
}

// Register middleware
db.use(myMiddleware);

// DBCore interface (internal, but exposed for middleware)
interface DBCore {
  transaction(tables: string[], mode: TransactionMode): DBCoreTransaction;

  // Table operations
  table(name: string): DBCoreTable;
}

interface DBCoreTable {
  get(trans: DBCoreTransaction, key: any): Promise<any>;
  getMany(trans: DBCoreTransaction, keys: any[]): Promise<any[]>;
  put(trans: DBCoreTransaction, values: any[], keys?: any[]): Promise<any[]>;
  add(trans: DBCoreTransaction, values: any[], keys?: any[]): Promise<any[]>;
  delete(trans: DBCoreTransaction, keys: any[]): Promise<void>;
  deleteRange(trans: DBCoreTransaction, range: DBCoreKeyRange): Promise<void>;
  count(trans: DBCoreTransaction, range?: DBCoreKeyRange): Promise<number>;
  query(trans: DBCoreTransaction, request: DBCoreQueryRequest): Promise<DBCoreQueryResponse>;
  openCursor(trans: DBCoreTransaction, request: DBCoreQueryRequest): Promise<DBCoreCursor | null>;
}
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
  type: 'add' | 'put' | 'delete';
  key: any;
  obj?: any;
  oldObj?: any;
}

// Usage
db.on('ready', () => console.log('Database ready'));
db.on('changes', (changes) => {
  // React to changes (for sync, reactivity, etc.)
});
```

---

## Browser Compatibility

### Required Polyfills

LessDB handles these internally:

| Issue | Browser | Fix |
|-------|---------|-----|
| Vendor prefixes | Old Safari/Firefox/IE | Check `mozIndexedDB`, `webkitIndexedDB`, `msIndexedDB` |
| Safari 8 multi-store bug | Safari 8 | `safariMultiStoreFix()` - reduce store names |
| Safari 8 version overflow | Safari 8 | Treat `oldVersion > 2^62` as 0 |
| Safari 14 IDB bug | Safari 14 | Use `safari-14-idb-fix` |
| Safari getAll() bug | Safari < 604 | Fall back to cursor iteration |
| Safari private mode | Safari | Handle null from `indexedDB.open()` |
| Safari instanceof | Safari | Use `Object.prototype.toString` for type checks |
| Chrome UnknownError | Chrome | Retry open() up to 3 times after site data clear |
| IE/Edge/Safari versionchange | IE, Edge, Safari | Emulate via connection tracking |
| Back/forward cache | All modern | Close/reopen on `pagehide`/`pageshow` |
| Undefined primary key | All | Remove undefined key property before add |
| Max key differences | All | Detect `[[]]` vs max string support |

### Implementation

```typescript
// src/compat/index.ts

export const indexedDB =
  globalThis.indexedDB ||
  globalThis.mozIndexedDB ||
  globalThis.webkitIndexedDB ||
  globalThis.msIndexedDB;

export const IDBKeyRange =
  globalThis.IDBKeyRange ||
  globalThis.webkitIDBKeyRange;

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
  if (typeof navigator === 'undefined') return true;
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
  if (t !== 'object') return t;
  if (value === null) return 'null';
  if (ArrayBuffer.isView(value)) return 'binary';
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === 'ArrayBuffer' ? 'binary' : tag.toLowerCase();
}

// Undefined primary key workaround
export function fixUndefinedKey<T>(obj: T, keyPath: string): T {
  if (typeof keyPath !== 'string' || keyPath.includes('.')) return obj;
  if (obj[keyPath] === undefined && keyPath in obj) {
    const clone = { ...obj };
    delete clone[keyPath];
    return clone;
  }
  return obj;
}

// bfcache support
export function setupBfCacheHandling(db: LessDB): void {
  if (typeof addEventListener === 'undefined') return;

  addEventListener('pagehide', (event) => {
    if ((event as PageTransitionEvent).persisted) {
      db.close({ disableAutoOpen: false });
    }
  });

  addEventListener('pageshow', (event) => {
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
│        (Hooks, Future: Cache, Observability)            │
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

## Error Handling

```typescript
// Error classes (match Dexie for compatibility)
class LessDBError extends Error {
  constructor(message: string, public inner?: Error) {
    super(message);
    this.name = 'LessDBError';
  }
}

class ConstraintError extends LessDBError { name = 'ConstraintError'; }
class NotFoundError extends LessDBError { name = 'NotFoundError'; }
class InvalidStateError extends LessDBError { name = 'InvalidStateError'; }
class InvalidTableError extends LessDBError { name = 'InvalidTableError'; }
class DataError extends LessDBError { name = 'DataError'; }
class AbortError extends LessDBError { name = 'AbortError'; }

// Typed catch
db.friends.add(friend)
  .catch(ConstraintError, (err) => {
    console.log('Duplicate key');
  })
  .catch((err) => {
    console.log('Other error:', err);
  });
```

---

## Future Extensions (Designed For)

### Live Queries (Reactivity)

```typescript
// Future API
import { liveQuery } from 'less-db';

const friends$ = liveQuery(() =>
  db.friends.where('age').below(30).toArray()
);

friends$.subscribe(friends => {
  console.log('Friends updated:', friends);
});
```

Implementation via middleware that:
1. Tracks which tables/ranges are read during query
2. Listens to `changes` event
3. Re-runs query when relevant changes occur

### Encryption Middleware

```typescript
// Future API
import { encryptionMiddleware } from 'less-db-encryption';

db.use(encryptionMiddleware({
  key: myEncryptionKey,
  tables: {
    friends: ['name', 'email'],  // Encrypt these fields
    secrets: true                 // Encrypt entire objects
  }
}));
```

### Sync Tracking Middleware

```typescript
// Future API
import { syncMiddleware } from 'less-db-sync';

db.use(syncMiddleware({
  onLocalChange: (change) => {
    // Queue for sync
  },
  getRemoteChanges: async (since) => {
    // Fetch from server
  }
}));
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

### Phase 4: Polish
- [x] Full TypeScript generics
- [x] Comprehensive tests (253 tests)
- [ ] Documentation
- [ ] Performance optimization

---

## API Compatibility with Dexie

**Goal**: LessDB should be a drop-in replacement for Dexie.js in common use cases. Migrating from Dexie to LessDB should require minimal code changes.

### Compatibility Matrix

| Feature | LessDB | Dexie | Notes |
|---------|--------|-------|-------|
| `new DB(name)` | ✅ | ✅ | Identical |
| `db.version(n).stores({})` | ✅ | ✅ | Identical |
| `db.table.get/add/put/update/delete` | ✅ | ✅ | Identical |
| `db.table.upsert()` | ✅ | ✅ | Identical |
| `db.table.bulkGet/bulkAdd/bulkPut/bulkDelete` | ✅ | ✅ | Identical |
| `db.table.bulkUpdate()` | ✅ | ✅ | Identical |
| `db.table.where().equals/equalsIgnoreCase()` | ✅ | ✅ | Identical |
| `db.table.where().above/below/between()` | ✅ | ✅ | Identical |
| `db.table.where().anyOf/anyOfIgnoreCase/noneOf()` | ✅ | ✅ | Identical |
| `db.table.where().inAnyRange()` | ✅ | ✅ | Identical |
| `db.table.where().startsWith/startsWithIgnoreCase()` | ✅ | ✅ | Identical |
| `db.table.where().startsWithAnyOf/startsWithAnyOfIgnoreCase()` | ✅ | ✅ | Identical |
| `collection.filter().limit().offset()` | ✅ | ✅ | Identical |
| `collection.or()` | ✅ | ✅ | Identical |
| `collection.until()` | ✅ | ✅ | Identical |
| `collection.clone()` | ✅ | ✅ | Identical |
| `collection.first/last/count/toArray()` | ✅ | ✅ | Identical |
| `collection.firstKey/lastKey/eachKey/eachPrimaryKey()` | ✅ | ✅ | Identical |
| `collection.modify/delete()` | ✅ | ✅ | Identical |
| `collection.raw()` | ✅ | ✅ | Identical |
| `db.transaction('rw', [...], fn)` | ✅ | ✅ | Identical |
| `db.table.hook.creating/reading/etc` | ✅ | ✅ | Identical |
| `db.on('ready'/'close'/etc)` | ✅ | ✅ | Identical |
| `db.use(middleware)` | ✅ | ✅ | Identical |
| `liveQuery()` | ❌ | ✅ | Not planned for v1 |
| Compound indexes `[a+b]` | ❌ | ✅ | Not planned for v1 |
| Multi-entry indexes `*tags` | ❌ | ✅ | Not planned for v1 |
| Entity classes / `mapToClass()` | ❌ | ✅ | Not planned |
| `collection.distinct/uniqueKeys/eachUniqueKey()` | ❌ | ✅ | Requires multi-entry indexes |

### Migration from Dexie

```typescript
// Before (Dexie)
import Dexie from 'dexie';
const db = new Dexie('MyApp');

// After (LessDB)
import { LessDB } from 'less-db';
const db = new LessDB('MyApp');

// Everything else stays the same!
```

---

## References

- [Dexie.js Source](https://github.com/dexie/Dexie.js)
- [IndexedDB Spec](https://www.w3.org/TR/IndexedDB/)
- [Safari 14 IDB Fix](https://github.com/nicopolacchi/safari-14-idb-fix)
- [MDN IndexedDB Guide](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
