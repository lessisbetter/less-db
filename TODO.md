# LessDB - Project Status

A minimal, extensible IndexedDB wrapper with **full API compatibility with [Dexie.js](https://dexie.org/)**.

## Overview

LessDB is a drop-in replacement for Dexie.js for common use cases. It provides the same API so you can migrate from Dexie with minimal code changes—typically just changing the import.

**Design Goals:**

1. **Dexie-Compatible** - Same API, easy migration
2. **Simple** - Core functionality in ~1000 lines
3. **Extensible** - Hooks and middleware for reactivity, encryption, sync
4. **Typed** - First-class TypeScript support

**Current Status**: Phase 1, 2, 2b, and 3 complete

---

## Completed ✅

### Phase 1: Core (MVP)

- [x] Schema parsing (`'++id, name, &email'` syntax)
- [x] LessDB class with `version().stores()` chaining
- [x] Table with basic CRUD (`get`, `add`, `put`, `update`, `delete`)
- [x] Collection class (`filter`, `toArray`, `count`, `first`, `last`)
- [x] Transaction support (`db.transaction('rw', [...], fn)`)
- [x] Browser compatibility layer (Safari 8/14, Chrome, vendor prefixes)
- [x] Error classes (ConstraintError, NotFoundError, etc.)

### Phase 2: Query Power

- [x] WhereClause with all range methods
  - `equals`, `notEqual`, `anyOf`, `noneOf`
  - `above`, `aboveOrEqual`, `below`, `belowOrEqual`, `between`
  - `startsWith`, `startsWithIgnoreCase`
- [x] Collection chaining (`and`, `filter`, `limit`, `offset`, `reverse`)
- [x] Bulk operations (`bulkGet`, `bulkAdd`, `bulkPut`, `bulkDelete`)
- [x] `orderBy` / `sortBy`
- [x] Collection mutations (`modify`, `delete`)
- [x] `primaryKeys()` / `keys()`

### Phase 2b: Additional Dexie API Compatibility

- [x] `Table.upsert()` - Add or update in one call
- [x] `Table.bulkUpdate()` - Batch update operations
- [x] `WhereClause.anyOfIgnoreCase()` - Case-insensitive anyOf
- [x] `WhereClause.startsWithAnyOf()` - Multiple prefix matching
- [x] `WhereClause.startsWithAnyOfIgnoreCase()` - Case-insensitive multiple prefix
- [x] `WhereClause.inAnyRange()` - Complex range queries
- [x] `Collection.or()` - Combine queries with OR logic
- [x] `Collection.until()` - Stop iteration on condition
- [x] `Collection.clone()` - Copy collection configuration
- [x] `Collection.desc()` - Alias for reverse()
- [x] `Collection.raw()` - Skip reading hooks flag
- [x] `Collection.eachKey()` - Iterate over keys only
- [x] `Collection.eachPrimaryKey()` - Iterate over primary keys
- [x] `Collection.firstKey()` - Get first key without value
- [x] `Collection.lastKey()` - Get last key without value

### Phase 3: Extensibility

- [x] Table hooks (`creating`, `reading`, `updating`, `deleting`)
- [x] Database events (`ready`, `blocked`, `versionchange`, `close`, `changes`)
- [x] DBCore abstraction layer (foundation for middleware)
- [x] **Middleware system** - `db.use(middleware)` and `db.unuse(middleware)` API
- [x] **bfcache handling** - `setupBfCacheHandling()` for back/forward cache support

### Infrastructure

- [x] TypeScript with strict types
- [x] Vitest test suite (692+ tests passing)
- [x] ~80% code coverage

---

## Remaining 🚧

### Phase 4: Dexie Deep Alignment

Based on comprehensive analysis of Dexie.js source code, these patterns are critical for full compatibility and advanced use cases like sync.

#### 4.1 Transaction Management (High Priority)

##### 4.1.1 Implicit Transactions ✅ DONE

**Status**: Fully implemented. Table methods automatically create per-operation transactions when called outside an explicit transaction.

**Example behavior**:

```typescript
// Works without explicit transaction - auto-creates per-operation transactions
const user = await db.users.get(1); // Auto-creates readonly transaction
await db.users.add({ name: "Alice" }); // Auto-creates readwrite transaction
```

##### 4.1.2 PSD (Promise-Specific Data)

**Goal**: Track transaction context across async boundaries so nested calls reuse parent transaction.

**Dexie reference**: `src/helpers/promise.ts` - PSD implementation

**Implementation options**:

1. **Zone.js pattern** (Dexie's approach)
   - Wrap Promise.prototype.then to propagate context
   - Store transaction in global PSD object
   - Most compatible but invasive

2. **AsyncLocalStorage** (Node.js only)
   - Use Node's `AsyncLocalStorage` for server-side
   - Clean but not browser-compatible

3. **Explicit context passing** (Least invasive)
   - Require transaction to be passed explicitly
   - Less ergonomic but simpler

**Implementation tasks**:

- [ ] Research AsyncLocalStorage browser alternatives (none reliable as of 2024)
- [ ] Implement PSD pattern following Dexie's `src/helpers/promise.ts`
- [ ] Create `usePSD()` wrapper for transaction functions
- [ ] Wrap internal promises to propagate PSD
- [ ] Add `PSD.trans` property for ambient transaction access
- [ ] Add tests for PSD propagation across async boundaries

##### 4.1.3 Nested Transaction Reuse

**Goal**: When nested transaction requests subset of parent's tables, reuse parent.

**Dexie reference**: `src/classes/Dexie/dexie-open.ts` - transaction reuse logic

**Implementation tasks**:

- [ ] Check for active parent transaction when starting new transaction
- [ ] Validate table subset (nested tables ⊆ parent tables)
- [ ] Validate mode compatibility (readonly can nest in readwrite)
- [ ] Return parent transaction if compatible, else queue or throw
- [ ] Add `maxWait` option for queuing behavior (like Dexie)

##### 4.1.4 Blocked Function Queue

**Goal**: Queue operations waiting for transaction access instead of failing.

**Dexie reference**: `src/classes/Dexie/dexie-open.ts` - `blockedFunc` handling

**Implementation tasks**:

- [ ] Add transaction wait queue per table set
- [ ] Implement `waitForTransaction()` with timeout
- [ ] Queue blocked functions when transaction unavailable
- [ ] Execute queued functions when transaction becomes available
- [ ] Add configurable timeout (default: 10 seconds like Dexie)

---

#### 4.2 Error Handling (High Priority)

##### 4.2.1 Expanded Error Types ✅ DONE

**Goal**: Match Dexie's complete error hierarchy.

**All error types implemented** (19 types):

- [x] `LessDBError` - Base error class
- [x] `AbortError` - Transaction was aborted
- [x] `BlockedError` - Database blocked by another connection
- [x] `ConstraintError` - Constraint violation (duplicate key, etc.)
- [x] `DatabaseClosedError` - Database was closed
- [x] `DataCloneError` - Cannot clone data for storage
- [x] `DataError` - Invalid data provided
- [x] `InvalidAccessError` - Access violation
- [x] `InvalidStateError` - Invalid state for operation
- [x] `InvalidTableError` - Invalid table referenced
- [x] `MissingAPIError` - IndexedDB not available
- [x] `NotFoundError` - Record not found
- [x] `OpenFailedError` - Failed to open database
- [x] `QuotaExceededError` - Storage quota exceeded
- [x] `ReadOnlyError` - Write in readonly transaction
- [x] `SchemaError` - Schema definition error
- [x] `TimeoutError` - Operation timeout
- [x] `TransactionInactiveError` - Transaction no longer active
- [x] `VersionChangeError` - Version change detected

##### 4.2.2 Type-Based Error Catching ✅ DONE

**Goal**: Enable `promise.catch(ErrorType, handler)` pattern.

**Implementation** (`src/promise.ts`):

- [x] `LessDBPromise<T>` class extending Promise
- [x] Overloaded `.catch()` that accepts error constructor as first arg
- [x] Type checking in catch handler - matches error instances
- [x] Chain multiple type-based catches correctly
- [x] All Table methods return LessDBPromise
- [x] Tests in `test/promise.test.ts` (27 tests)

**Usage**:

```typescript
db.users
  .add(user)
  .catch(ConstraintError, (err) => console.log("Duplicate!"))
  .catch((err) => console.log("Other error"));
```

##### 4.2.3 Error Mapping ✅ DONE

**Goal**: Map IndexedDB DOMException to semantic LessDB error types.

**Implementation**:

- [x] `mapError()` function in `src/errors/errors.ts`
- [x] Maps all known DOMException.name values to error types
- [x] Preserves original error in `.inner` property
- [x] Applied at DBCore boundary (indexeddb-adapter)
- [x] Tests for error mapping in `test/errors/errors.test.ts`

---

#### 4.3 Middleware Enhancements (Medium Priority)

##### 4.3.1 Hooks as Middleware

**Goal**: Implement table hooks via DBCore middleware for consistency.

**Dexie reference**: `src/hooks/hooks-middleware.ts`

**Benefits**:

- Single interception point for all operations
- Hooks can cancel/modify operations
- Consistent with other middleware

**Implementation tasks**:

- [ ] Create `createHooksMiddleware()` function
- [ ] Move hook firing from Table methods to middleware
- [ ] Support hook return values for cancellation
- [ ] Ensure hooks fire in correct order (creating before add, etc.)
- [ ] Maintain backward compatibility with existing hook API
- [ ] Add tests for hooks via middleware

##### 4.3.2 Cache Middleware ✅ DONE

**Status**: Fully implemented in `src/middleware/cache.ts` with:

- [x] `createCacheMiddleware(options)` factory
- [x] Transaction-level caching (per-transaction LRU cache)
- [x] Caches `get()` and `getMany()` results by key
- [x] Smart invalidation on `mutate()` operations
- [x] Configurable cache size limits (`maxSize` option)
- [x] `clearCache()` method on returned middleware
- [x] Comprehensive tests in `test/middleware/cache.test.ts`

##### 4.3.3 Observability Middleware

**Goal**: Standard middleware for logging/debugging/tracing.

**Implementation tasks**:

- [ ] Create `loggingMiddleware(options)` factory
- [ ] Log all DBCore operations with timing
- [ ] Support log levels (error, warn, info, debug)
- [ ] Support custom log handlers
- [ ] Include transaction ID in logs
- [ ] Add operation duration metrics

---

#### 4.4 Advanced Transaction Patterns (Medium Priority)

##### 4.4.1 Recursive Locking

**Goal**: Allow nested operations on same tables within transaction.

**Dexie reference**: `src/classes/Dexie/dexie-open.ts` - recursive transaction handling

**Implementation tasks**:

- [ ] Track transaction "owners" (call stacks)
- [ ] Allow re-entry for same owner
- [ ] Prevent deadlocks with timeout
- [ ] Add tests for recursive scenarios

##### 4.4.2 Transaction Abort Handling

**Goal**: Graceful handling when transactions abort.

**Implementation tasks**:

- [ ] Detect transaction abort via IDBTransaction.onerror
- [ ] Convert to AbortError with meaningful message
- [ ] Clean up any pending operations
- [ ] Support `transaction.on('abort')` event

---

#### 4.5 Live Query Foundation (Lower Priority)

##### 4.5.1 Query Tracking

**Goal**: Track which tables/ranges a query reads for change detection.

**Implementation tasks**:

- [ ] Create `QueryTracker` class
- [ ] Instrument Collection to record table/index/range access
- [ ] Store query "fingerprint" for comparison
- [ ] Support complex queries (OR, filters)

##### 4.5.2 Change Detection

**Goal**: Emit change events that can trigger query re-runs.

**Implementation tasks**:

- [ ] Create `changes` middleware that emits on every mutation
- [ ] Include table, key, old value, new value in change event
- [ ] Support batched change events (one event per transaction)
- [ ] Match change events to query fingerprints

##### 4.5.3 Observable Wrapper

**Goal**: Create `liveQuery()` function matching Dexie's API.

**Implementation tasks**:

- [ ] Create `liveQuery(queryFn)` function
- [ ] Return RxJS-compatible Observable
- [ ] Subscribe to change events
- [ ] Re-run query when relevant changes detected
- [ ] Debounce rapid changes
- [ ] Clean up on unsubscribe

---

### Phase 5: Polish

- [ ] **Documentation** - API docs, usage examples, migration guide from Dexie
- [ ] **Performance optimization** - Profile and optimize hot paths
- [ ] **Table proxy access** - `db.friends` shorthand (partially working, needs testing)

### Phase 5b: IndexedDB 3.0 Optimizations

Leverage modern IndexedDB 3.0 features for improved performance. All features have excellent browser support (Chrome 83+, Firefox 126+, Safari 15+).

#### 5b.1 Transaction Durability Hints (High Priority)

**Goal**: Use `durability: 'relaxed'` for faster writes when strict persistence isn't required.

**Browser support**: Chrome 83+, Firefox 126+, Safari 15.4+

**Implementation tasks**:

- [ ] Add `durability` option to transaction creation in `IDBCore.transaction()`
- [ ] Expose durability option through `db.transaction()` API
- [ ] Default to `'default'` for backwards compatibility
- [ ] Add feature detection in compat layer
- [ ] Document performance implications

**Usage**:

```typescript
// Fast writes (may lose data on crash)
await db.transaction(
  "rw",
  ["logs"],
  async (tx) => {
    await tx.table("logs").bulkAdd(logs);
  },
  { durability: "relaxed" },
);
```

#### 5b.2 Explicit Transaction Commit (Medium Priority)

**Goal**: Use `transaction.commit()` to start commit immediately without waiting for all requests.

**Browser support**: Chrome 76+, Firefox 74+, Safari 15+

**Implementation tasks**:

- [ ] Add `commit()` method to `IDBCoreTransaction` class
- [ ] Expose through `TransactionContext` API
- [ ] Use internally for bulk operations when beneficial
- [ ] Add feature detection

#### 5b.3 Use openKeyCursor() for Keys-Only Queries (Medium Priority)

**Goal**: Use `openKeyCursor()` instead of `openCursor()` when only keys are needed.

**Browser support**: Chrome 23+, Firefox 44+, Safari 10.1+ (very old)

**Current behavior**: Always uses `openCursor()` even when `values === false`

**Implementation tasks**:

- [ ] Modify `cursorQuery()` to use `openKeyCursor()` when `wantValues === false`
- [ ] Update `openCursor()` method in `IDBCoreTable`
- [ ] Benchmark improvement for `primaryKeys()` queries

#### 5b.4 Unique Cursor Directions (Low Priority)

**Goal**: Use `'nextunique'`/`'prevunique'` cursor directions for deduplication at engine level.

**Current behavior**: Manual deduplication in JavaScript via `lastKey` check

**Implementation tasks**:

- [ ] Use `'nextunique'`/`'prevunique'` when `req.unique === true`
- [ ] Remove JavaScript-level deduplication when using native unique directions
- [ ] Benchmark improvement

#### 5b.5 Multi-Entry Indexes (Low Priority)

**Goal**: Support `*tags` syntax for indexing array values.

**Implementation tasks**:

- [ ] Add `*` prefix parsing in schema-parser
- [ ] Pass `multiEntry: true` to `createIndex()`
- [ ] Update `DBCoreIndex` type to include `multiEntry` flag
- [ ] Add tests for multi-entry queries

---

### Future Extensions (Not Planned for v1)

- [ ] **Encryption middleware** - Encrypt specific fields or entire tables
- [ ] **Sync middleware** - Track local changes, apply remote changes
- [x] **Compound indexes** - `'++id, [firstName+lastName]'` ✅ DONE (fully implemented)
- [ ] **Multi-entry indexes** - `'++id, *tags'`

---

## File Structure

```
src/
├── index.ts              # Public exports
├── less-db.ts            # Main LessDB class
├── table.ts              # Table class (CRUD operations)
├── collection.ts         # Collection class (query results)
├── where-clause.ts       # WhereClause class (index queries)
├── transaction.ts        # Transaction management
├── schema-parser.ts      # Parse '++id, name' schema syntax
│
├── dbcore/
│   ├── index.ts          # DBCore exports
│   ├── types.ts          # DBCore interfaces
│   └── indexeddb-adapter.ts  # IDB implementation with compat fixes
│
├── compat/
│   └── index.ts          # Browser compatibility utilities
│
├── events/
│   ├── index.ts          # Event exports
│   └── events.ts         # Event, Hook, EventEmitter classes
│
└── errors/
    ├── index.ts          # Error exports
    └── errors.ts         # Error classes
```

---

## Test Coverage

| Module               | Tests   | Status |
| -------------------- | ------- | ------ |
| errors               | 93      | ✅     |
| compat               | 50      | ✅     |
| events               | 36      | ✅     |
| schema-parser        | 49      | ✅     |
| promise              | 28      | ✅     |
| dbcore               | 45      | ✅     |
| middleware (cache)   | 27      | ✅     |
| middleware (logging) | 18      | ✅     |
| middleware           | 10      | ✅     |
| hooks                | 22      | ✅     |
| compound-index       | 12      | ✅     |
| ignore-case          | 22      | ✅     |
| integration          | 66      | ✅     |
| less-db              | 268     | ✅     |
| **Total**            | **746** | ✅     |

---

## Known Limitations

1. **No multi-entry indexes** - Can't index into arrays (`*tags` syntax)
2. **Hook semantics** - `reading` hook uses "last value wins" if multiple handlers return values
3. **`put()` doesn't fire hooks** - Only `add()` fires `creating`, only `update()` fires `updating`

---

## Quick Start

```typescript
import { LessDB } from "less-db";

const db = new LessDB("MyApp");

db.version(1).stores({
  users: "++id, name, &email",
  posts: "++id, userId, createdAt",
});

await db.open();

// CRUD
const id = await db.table("users").add({ name: "Alice", email: "alice@example.com" });
const user = await db.table("users").get(id);

// Queries
const recentPosts = await db
  .table("posts")
  .where("createdAt")
  .above(Date.now() - 86400000)
  .limit(10)
  .toArray();

// Transactions
await db.transaction("rw", ["users", "posts"], async (tx) => {
  const userId = await tx.table("users").add({ name: "Bob", email: "bob@example.com" });
  await tx.table("posts").add({ userId, title: "Hello", createdAt: Date.now() });
});
```

---

## References

- [SPEC.md](./SPEC.md) - Full specification
- [Dexie.js](https://dexie.org/) - Inspiration and API reference
- [IndexedDB MDN](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
