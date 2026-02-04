# LessDB - Project Status

A minimal, extensible IndexedDB wrapper inspired by [Dexie.js](https://dexie.org/).

## Overview

LessDB aims to provide a simple, type-safe API for IndexedDB while maintaining extensibility for features like reactivity and sync. It borrows many patterns from Dexie.js but focuses on simplicity (~1000 lines for core functionality).

**Current Status**: Phase 1 & 2 complete, Phase 3 partial

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

### Phase 3: Extensibility (Partial)
- [x] Table hooks (`creating`, `reading`, `updating`, `deleting`)
- [x] Database events (`ready`, `blocked`, `versionchange`, `close`, `changes`)
- [x] DBCore abstraction layer (foundation for middleware)

### Infrastructure
- [x] TypeScript with strict types
- [x] Vitest test suite (226 tests passing)
- [x] ~80% code coverage

---

## Remaining 🚧

### Phase 3: Extensibility (Remaining)
- [ ] **Middleware system** - `db.use(middleware)` API for wrapping DBCore
  - Needed for: encryption, sync tracking, caching, logging
  - DBCore interfaces exist, just need the registration/wrapping logic
- [ ] **bfcache handling** - Close/reopen on `pagehide`/`pageshow`
  - `setupBfCacheHandling()` function exists in spec but not implemented

### Phase 4: Polish
- [ ] **Documentation** - API docs, usage examples, migration guide from Dexie
- [ ] **Performance optimization** - Profile and optimize hot paths
- [ ] **Auto-open** - Currently requires explicit `db.open()`, could auto-open on first operation
- [ ] **Table proxy access** - `db.friends` shorthand (partially working, needs testing)

### Future Extensions (Designed For, Not Planned for v1)
- [ ] **Live queries / reactivity** - `liveQuery(() => db.friends.toArray())`
- [ ] **Encryption middleware** - Encrypt specific fields or entire tables
- [ ] **Sync middleware** - Track local changes, apply remote changes
- [ ] **Compound indexes** - `'++id, [firstName+lastName]'`
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

| Module | Tests | Status |
|--------|-------|--------|
| errors | 24 | ✅ |
| compat | 37 | ✅ |
| events | 33 | ✅ |
| schema-parser | 35 | ✅ |
| dbcore | 36 | ✅ |
| less-db (integration) | 61 | ✅ |
| **Total** | **226** | ✅ |

---

## Known Limitations

1. **No compound indexes** - Can't do `where(['firstName', 'lastName']).equals(['John', 'Doe'])`
2. **No multi-entry indexes** - Can't index into arrays
3. **Hook semantics** - `reading` hook uses "last value wins" if multiple handlers return values
4. **`put()` doesn't fire hooks** - Only `add()` fires `creating`, only `update()` fires `updating`

---

## Quick Start

```typescript
import { LessDB } from 'less-db';

const db = new LessDB('MyApp');

db.version(1).stores({
  users: '++id, name, &email',
  posts: '++id, userId, createdAt'
});

await db.open();

// CRUD
const id = await db.table('users').add({ name: 'Alice', email: 'alice@example.com' });
const user = await db.table('users').get(id);

// Queries
const recentPosts = await db.table('posts')
  .where('createdAt')
  .above(Date.now() - 86400000)
  .limit(10)
  .toArray();

// Transactions
await db.transaction('rw', ['users', 'posts'], async (tx) => {
  const userId = await tx.table('users').add({ name: 'Bob', email: 'bob@example.com' });
  await tx.table('posts').add({ userId, title: 'Hello', createdAt: Date.now() });
});
```

---

## References

- [SPEC.md](./SPEC.md) - Full specification
- [Dexie.js](https://dexie.org/) - Inspiration and API reference
- [IndexedDB MDN](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
