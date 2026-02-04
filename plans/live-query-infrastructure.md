# LiveQuery Infrastructure Implementation Plan

## Goal

Implement the infrastructure to support `liveQuery()` and `useLiveQuery()` - enabling reactive queries that automatically re-execute when relevant data changes.

## Design Philosophy: Explicit Tracking

Rather than using implicit context propagation (like Dexie's PSD/zones), we use **explicit tracking**. The querier function receives a `tracked` database wrapper that records all read operations.

**Benefits:**
- Works identically in JavaScript and Dart
- No monkey-patching or runtime magic
- Clear data flow - you can see what's being tracked
- Easier to debug and reason about

```typescript
// JavaScript/TypeScript
liveQuery(db, async (tracked) => {
  return await tracked.users.where('age').above(21).toArray();
});

// Dart - identical API
liveQuery(db, (tracked) async {
  return await tracked.users.where('age').above(21).toArray();
});
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│              liveQuery(db, querier)                         │
│    querier receives TrackedDB, returns Observable<T>        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     TrackedDB                                │
│    Wraps LessDB, passes ObservabilitySet to all operations  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Subscription Registry                        │
│    Tracks active subscriptions + their ObservabilitySets    │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
┌──────────────────────┐              ┌──────────────────────┐
│ Observability        │              │ Cross-Tab Sync       │
│ Middleware           │              │ (BroadcastChannel)   │
│ - Records reads      │              └──────────────────────┘
│ - Emits mutations    │
└──────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                        DBCore                                │
└─────────────────────────────────────────────────────────────┘
```

### How Tracking Works

1. `liveQuery()` creates an `ObservabilitySet` and a `TrackedDB` wrapper
2. The querier is called with the `TrackedDB`
3. `TrackedDB` passes the `ObservabilitySet` to all read operations via a request option
4. The observability middleware sees the tracking context and records ranges
5. After the querier completes, the `ObservabilitySet` contains all accessed ranges
6. The subscription is registered with this set for future change detection

## Key Components

### 1. RangeSet (`src/live-query/range-set.ts`)

Interval storage for efficient range overlap detection.

```typescript
export class RangeSet {
  add(lower: unknown, upper: unknown, lowerOpen?: boolean, upperOpen?: boolean): void;
  addKey(key: unknown): void;
  addAll(): void;
  overlaps(other: RangeSet): boolean;
  clone(): RangeSet;
}
```

Uses `compareKeys` from `compat/index.ts` for IndexedDB key ordering.

### 2. ObservabilitySet (`src/live-query/types.ts`)

Maps `idb://dbName/tableName/indexName` → `RangeSet`.

```typescript
export type ObservabilitySet = { [part: string]: RangeSet };

export function createObservabilitySet(): ObservabilitySet;
export function addRange(
  set: ObservabilitySet,
  dbName: string,
  table: string,
  index: string,
  range: DBCoreKeyRange,
): void;
export function observabilitySetsOverlap(a: ObservabilitySet, b: ObservabilitySet): boolean;
```

### 3. TrackedDB Wrapper (`src/live-query/tracked-db.ts`)

Wraps LessDB to inject tracking context into all read operations:

```typescript
export class TrackedDB {
  constructor(
    private db: LessDB,
    private obsSet: ObservabilitySet,
  ) {}

  table<T, TKey>(name: string): TrackedTable<T, TKey> {
    return new TrackedTable(this.db.table(name), this.obsSet, this.db.name);
  }

  // Proxy for direct table access: tracked.users
  // Uses Proxy to intercept property access
}

export class TrackedTable<T, TKey> {
  // Wraps Table methods to pass obsSet in request options
  // e.g., get(), toArray(), where().toArray() all pass { _obsSet: this.obsSet }
}
```

### 4. Observability Middleware (`src/live-query/observability-middleware.ts`)

Intercepts all DBCore operations:

**Reads**: When request has `_obsSet` option, records accessed ranges

- `get()` → record single key
- `getMany()` → record all keys
- `query()` → record index + range
- `count()` → record full range (conservative)
- `openCursor()` → record range

**Mutations**: After successful mutation, builds affected ObservabilitySet and notifies registry

- `add/put` → record primary keys + indexed values
- `delete` → record primary keys + mark all indexes affected
- `deleteRange` → record range + mark all indexes affected

### 5. Subscription Registry (`src/live-query/subscription-registry.ts`)

```typescript
export class SubscriptionRegistry {
  register(obsSet: ObservabilitySet, notify: () => void): string;
  update(id: string, obsSet: ObservabilitySet): void;
  unregister(id: string): void;
  notifyChanges(mutated: ObservabilitySet): void; // Batched via setTimeout(0)
  requeryAll(): void; // For bfcache restoration
}
```

### 6. liveQuery Function (`src/live-query/live-query.ts`)

```typescript
export type TrackedQuerier<T> = (tracked: TrackedDB) => Promise<T> | T;

export function liveQuery<T>(db: LessDB, querier: TrackedQuerier<T>): Observable<T>;
```

The querier receives a `TrackedDB` instance that records all read operations.

Returns minimal Observable (compatible with RxJS):

```typescript
interface Observable<T> {
  subscribe(observer: Observer<T> | ((value: T) => void)): Subscription;
}
```

### 7. Cross-Tab Sync (`src/live-query/cross-tab.ts`)

Uses BroadcastChannel to notify other tabs of mutations:

```typescript
export class CrossTabSync {
  start(): void;
  stop(): void;
  broadcastMutation(affected: ObservabilitySet): void;
}
```

## File Structure

```
src/live-query/
  index.ts                     # Public exports
  types.ts                     # ObservabilitySet, Observable, Subscription types
  range-set.ts                 # RangeSet class
  tracked-db.ts               # TrackedDB and TrackedTable wrappers
  observability-middleware.ts  # DBCore middleware
  subscription-registry.ts     # Registry class
  live-query.ts               # liveQuery function
  cross-tab.ts                # BroadcastChannel sync
```

## Implementation Order

### Phase 1: Core Data Structures

1. `types.ts` - Define types and helper functions
2. `range-set.ts` - Implement RangeSet with overlap detection

### Phase 2: Tracking Infrastructure

3. `tracked-db.ts` - TrackedDB and TrackedTable wrappers
4. `subscription-registry.ts` - Subscription management with batching
5. `observability-middleware.ts` - Read tracking + mutation detection

### Phase 3: User-Facing API

6. `live-query.ts` - Observable wrapper
7. `cross-tab.ts` - BroadcastChannel integration
8. `index.ts` - Public exports

### Phase 4: Integration

9. Update `less-db.ts`:
   - Add `_liveQueryRegistry` property
   - Register observability middleware in `buildCore()`
   - Implement `_requery()` method (placeholder already exists)
   - Add `enableLiveQueries()` method (opt-in initially)
10. Update `src/index.ts` - Export liveQuery and types

## How Explicit Tracking Works

The liveQuery function creates a TrackedDB and passes it to the querier:

```typescript
export function liveQuery<T>(
  db: LessDB,
  querier: (tracked: TrackedDB) => Promise<T> | T,
): Observable<T> {
  return {
    subscribe(observer) {
      let subscriptionId: string | null = null;

      const executeQuery = async () => {
        // Create tracking context
        const obsSet = createObservabilitySet();
        const tracked = new TrackedDB(db, obsSet);

        // Execute querier with tracked db
        const result = await querier(tracked);

        // obsSet now contains all ranges that were read
        // Register/update subscription with this obsSet
        if (subscriptionId) {
          registry.update(subscriptionId, obsSet);
        } else {
          subscriptionId = registry.register(obsSet, executeQuery);
        }

        observer.next(result);
      };

      executeQuery();

      return {
        unsubscribe() {
          if (subscriptionId) {
            registry.unregister(subscriptionId);
          }
        },
      };
    },
  };
}
```

The TrackedTable passes the obsSet via request options:

```typescript
class TrackedTable<T, TKey> {
  constructor(
    private table: Table<T, TKey>,
    private obsSet: ObservabilitySet,
    private dbName: string,
  ) {}

  async get(key: TKey): Promise<T | undefined> {
    // Pass obsSet in request options
    return this.table._coreTable.get({
      trans: this.table._getTransaction(),
      key,
      _obsSet: this.obsSet,  // Middleware will see this
    });
  }

  // ... similar for other read methods
}
```

The observability middleware checks for `_obsSet` in the request:

```typescript
query(req) {
  const obsSet = req._obsSet as ObservabilitySet | undefined;
  if (obsSet) {
    addRange(obsSet, dbName, tableName, indexName, req.query.range);
  }
  return downTable.query(req);
}
```

## Key Files to Modify

- `src/less-db.ts` - Add registry, middleware registration
- `src/dbcore/types.ts` - May need to export additional helpers
- `src/index.ts` - Export new public API

## Testing Strategy

### Unit Tests (`test/live-query/`)

- `range-set.test.ts` - Range operations, overlap detection, key comparison
- `observability-set.test.ts` - Part key formatting, overlap detection
- `tracked-db.test.ts` - Tracked wrapper correctly passes obsSet
- `subscription-registry.test.ts` - Register/unregister, batched notifications
- `observability-middleware.test.ts` - Read tracking, mutation detection

### Integration Tests

- `live-query.test.ts`:
  - Re-executes when queried data changes
  - Does NOT re-execute when unrelated data changes
  - Handles multiple concurrent subscriptions
  - Proper cleanup on unsubscribe
  - Error handling in querier
- `cross-tab.test.ts` - Message serialization, self-filtering

## Verification

1. Run existing test suite: `pnpm test:run`
2. Run new live-query tests: `pnpm test:run test/live-query/`
3. Manual verification:

   ```typescript
   const db = new LessDB("test");
   db.version(1).stores({ users: "++id, age" });
   await db.open();

   // Note: querier receives 'tracked' - use it for reads!
   const sub = liveQuery(db, (tracked) =>
     tracked.table("users").where("age").above(21).toArray()
   ).subscribe((users) => console.log("Users:", users));

   await db.table("users").add({ age: 25 }); // Should trigger re-query
   await db.table("users").add({ age: 18 }); // Should NOT trigger re-query

   sub.unsubscribe();
   ```

## Future: Framework Integrations

The Observable return type enables easy framework integration:

### React

```typescript
// Future: src/react/use-live-query.ts
export function useLiveQuery<T>(
  db: LessDB,
  queryFn: (tracked: TrackedDB) => Promise<T> | T,
  deps: unknown[],
  defaultValue: T,
): T;

// Usage
function UserList() {
  const adults = useLiveQuery(
    db,
    (tracked) => tracked.users.where('age').above(21).toArray(),
    [],
    [],
  );
  return <ul>{adults.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

### Flutter

```dart
// Future: lib/src/flutter/live_query_builder.dart
class LiveQueryBuilder<T> extends StatefulWidget {
  final LessDB db;
  final Future<T> Function(TrackedDB tracked) queryFn;
  final Widget Function(BuildContext context, T data) builder;
  // ...
}

// Usage
LiveQueryBuilder<List<User>>(
  db: db,
  queryFn: (tracked) => tracked.users.where('age').above(21).toArray(),
  builder: (context, adults) => ListView(
    children: adults.map((u) => Text(u.name)).toList(),
  ),
)
```

These are not part of this implementation but the infrastructure supports them.
