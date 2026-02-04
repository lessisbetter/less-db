# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LessDB is a minimal, extensible IndexedDB wrapper inspired by Dexie.js. It provides a fluent API for browser-based database operations with TypeScript support.

## Commands

```bash
pnpm install        # Install dependencies
pnpm build          # Build (TypeScript compilation)
pnpm test           # Run tests in watch mode
pnpm test:run       # Run tests once
pnpm test:run test/path/to/file.test.ts  # Run a single test file
pnpm test:coverage  # Run tests with coverage
pnpm typecheck      # Type check without emitting
pnpm check          # Run format + typecheck + tests (CI validation)
```

## Architecture

### Layer Structure

The codebase follows a layered architecture with clear separation of concerns:

```
User API (LessDB, Table, Collection, WhereClause)
              ↓
         DBCore (abstraction layer for middleware)
              ↓
    IndexedDB Adapter (low-level IDB operations)
```

### Core Components

**LessDB** (`src/less-db.ts`) - Main database class. Handles schema versioning, database lifecycle, middleware registration, and transaction coordination. Tables are lazily created as properties via proxies.

**DBCore** (`src/dbcore/`) - Internal abstraction layer enabling middleware interception of all database operations. Defines types for transactions, queries, mutations, and key ranges. The `createIDBCore()` function creates the base implementation that wraps IndexedDB.

**Table** (`src/table.ts`) - Primary API for CRUD operations. Provides `get`, `add`, `put`, `update`, `upsert`, `delete` for single items and `bulkGet`, `bulkAdd`, `bulkPut`, `bulkUpdate`, `bulkDelete` for batches. Integrates with hooks for lifecycle events.

**Collection** (`src/collection.ts`) - Lazy query builder for filtered/sorted record sets. Supports chaining with `filter`, `limit`, `offset`, `reverse`, `until`, and `or` for combining queries. Terminal operations: `toArray`, `first`, `last`, `count`, `primaryKeys`, `modify`, `delete`.

**WhereClause** (`src/where-clause.ts`) - Index-based query builder with methods like `equals`, `above`, `below`, `between`, `anyOf`, `startsWith`. Returns Collection instances for further chaining.

**Transaction** (`src/transaction.ts`) - Transaction coordination with `TransactionContext` providing scoped table access. Supports both explicit transactions via `db.transaction()` and implicit per-operation transactions.

### Schema Definition

Schemas use Dexie-style string syntax parsed by `src/schema-parser.ts`:

- `++id` - Auto-increment primary key
- `++` - Outbound auto-increment (key not in object)
- `&email` - Unique index
- `name, age` - Regular indexes

Example: `'++id, name, &email'` defines auto-increment id, indexed name, unique email.

### Events and Hooks

`src/events/` provides:

- `Event` - Simple pub/sub for database events (ready, blocked, versionchange, close)
- `Hook` - Transformable hooks for table operations (creating, reading, updating, deleting)

### Middleware System

Middleware wraps DBCore to intercept operations. Register with `db.use({ name, level?, create(core) })`. Lower level = closer to IndexedDB.

### Key Patterns

**Lazy Collections**: Collections don't execute until a terminal operation (`toArray`, `first`, `count`, etc.) is called. This enables query building via chaining.

**OR Queries**: `collection.or('indexName')` returns an `OrClause` that merges results from multiple index queries, deduplicating by primary key.

**Key Ranges**: The `DBCoreKeyRange` type (`src/dbcore/types.ts`) represents query bounds with types: `Equal`, `Range`, `Any`, `NotEqual`. Helper functions like `keyRangeEqual()`, `keyRangeRange()` create these.

## Testing

Tests use Vitest with `fake-indexeddb` for mocking IndexedDB (see `test/setup.ts`). Test files are in a separate `test/` directory that mirrors the `src/` structure.
