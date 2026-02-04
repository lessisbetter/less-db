/**
 * LessDB - main database class.
 *
 * A minimal, extensible IndexedDB wrapper inspired by Dexie.js.
 */

import {
  parseStores,
  diffSchemas,
  type DatabaseSchema,
  type TableSchema,
  type SchemaChange,
} from "./schema-parser.js";
import {
  type DBCore,
  type DBCoreTransaction,
  type TransactionMode,
  createIDBCore,
  createCacheMiddleware,
  createHooksMiddleware,
} from "./dbcore/index.js";
import { Table, createTable } from "./table.js";
import {
  executeTransaction,
  TransactionContext,
  type TransactionState,
  type TransactionOptions,
  type TxMode,
} from "./transaction.js";
import {
  EventEmitter,
  createTableHooks,
  type TableHooks,
  type DatabaseEvents,
} from "./events/index.js";
import {
  MissingAPIError,
  InvalidStateError,
  SchemaError,
  BlockedError,
  mapError,
} from "./errors/index.js";
import { getIndexedDB, fixOldVersion } from "./compat/index.js";

/**
 * Version definition for schema migrations.
 */
interface VersionDefinition {
  version: number;
  stores: Record<string, string>;
  upgrade?: (tx: TransactionContext) => Promise<void> | void;
}

/**
 * Middleware for wrapping database operations.
 * Follows Dexie.js middleware pattern for compatibility.
 */
export interface Middleware {
  /** Stack identifier - must be "dbcore" for DBCore middleware */
  stack: "dbcore";
  /** Middleware name (for identification and replacement) */
  name?: string;
  /** Execution order (lower = closer to IndexedDB). Default: 10 */
  level?: number;
  /** Create wrapped DBCore. Returns partial DBCore to be merged with down. */
  create(downCore: DBCore): Partial<DBCore>;
}

/**
 * Database state.
 */
interface DatabaseState {
  /** Whether the database is open */
  isOpen: boolean;
  /** The open IDBDatabase instance */
  idbDatabase?: IDBDatabase;
  /** The DBCore instance */
  core?: DBCore;
  /** Parsed schemas for all tables */
  schemas: Map<string, TableSchema>;
  /** Table hooks */
  tableHooks: Map<string, TableHooks<unknown, unknown>>;
  /** Current implicit transaction (for auto-commit operations) */
  implicitTransaction?: DBCoreTransaction;
}

/**
 * LessDB database class.
 */
export class LessDB {
  /** Database name */
  readonly name: string;

  /** Event emitter for database events */
  private events = new EventEmitter<DatabaseEvents>();

  /** Version definitions */
  private versions: VersionDefinition[] = [];

  /** Registered middleware */
  private middleware: Middleware[] = [];

  /** Internal state */
  private state: DatabaseState = {
    isOpen: false,
    schemas: new Map(),
    tableHooks: new Map(),
  };

  /** Open promise for deduplication */
  private openPromise?: Promise<void>;

  /** Retry count for Chrome UnknownError workaround */
  private openRetryCount = 3;

  constructor(name: string) {
    this.name = name;
  }

  // ========================================
  // Schema definition
  // ========================================

  /**
   * Define a schema version.
   */
  version(versionNumber: number): {
    stores: (stores: Record<string, string>) => LessDB & {
      upgrade: (fn: (tx: TransactionContext) => Promise<void> | void) => LessDB;
    };
  } {
    const db = this;
    return {
      stores: (stores: Record<string, string>) => {
        this.versions.push({
          version: versionNumber,
          stores,
        });

        // Parse and store schemas
        const parsed = parseStores(stores);
        for (const [name, schema] of Object.entries(parsed)) {
          this.state.schemas.set(name, schema);
        }

        // Return a proxy that delegates to db but adds upgrade()
        // The cast is safe because the Proxy actually provides both interfaces at runtime
        return new Proxy(db as object, {
          get(target, prop, receiver) {
            if (prop === "upgrade") {
              return (fn: (tx: TransactionContext) => Promise<void> | void) => {
                const v = db.versions.find((v) => v.version === versionNumber);
                if (v) {
                  v.upgrade = fn;
                }
                return db;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as LessDB & {
          upgrade: (fn: (tx: TransactionContext) => Promise<void> | void) => LessDB;
        };
      },
    };
  }

  // ========================================
  // Database lifecycle
  // ========================================

  /**
   * Open the database.
   */
  async open(): Promise<void> {
    if (this.state.isOpen) {
      return;
    }

    // Deduplicate concurrent open calls
    if (this.openPromise) {
      return this.openPromise;
    }

    this.openPromise = this.doOpen();

    try {
      await this.openPromise;
    } finally {
      this.openPromise = undefined;
    }
  }

  /**
   * Internal open implementation.
   */
  private async doOpen(): Promise<void> {
    const indexedDB = getIndexedDB();
    if (!indexedDB) {
      throw new MissingAPIError("IndexedDB is not available");
    }

    if (this.versions.length === 0) {
      throw new SchemaError("No schema versions defined. Call version().stores() first.");
    }

    // Sort versions
    this.versions.sort((a, b) => a.version - b.version);
    const latestVersion = this.getLatestVersionNumber();

    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.name, latestVersion);

      request.onerror = () => {
        const error = request.error;

        // Chrome UnknownError workaround - retry a few times
        if (error?.name === "UnknownError" && this.openRetryCount > 0) {
          this.openRetryCount--;
          console.warn("LessDB: Retrying open() after UnknownError");
          this.doOpen().then(resolve, reject);
          return;
        }

        reject(mapError(error));
      };

      request.onblocked = (event) => {
        this.events.emit("blocked", event);
        reject(new BlockedError("Database blocked by another connection"));
      };

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction;
        if (!transaction) {
          reject(new InvalidStateError("No transaction available during upgrade"));
          return;
        }
        const oldVersion = fixOldVersion(event.oldVersion);

        this.handleUpgrade(db, transaction, oldVersion, latestVersion).catch((error) => {
          transaction.abort();
          reject(error);
        });
      };

      request.onsuccess = () => {
        const db = request.result;

        // Set up event handlers
        db.onversionchange = (event) => {
          this.events.emit("versionchange", event);
        };

        db.onclose = () => {
          this.state.isOpen = false;
          this.state.idbDatabase = undefined;
          this.state.core = undefined;
          this.events.emit("close");
        };

        // Initialize state
        this.state.idbDatabase = db;
        this.state.core = this.buildCore(db);
        this.state.isOpen = true;

        // Create table proxies
        this.setupTableProxies();

        this.events.emit("ready");
        resolve();
      };
    });
  }

  /**
   * Handle database upgrade.
   */
  private async handleUpgrade(
    db: IDBDatabase,
    transaction: IDBTransaction,
    oldVersion: number,
    newVersion: number,
  ): Promise<void> {
    let currentSchema: DatabaseSchema = {};

    for (const versionDef of this.versions) {
      if (versionDef.version <= oldVersion) {
        currentSchema = { ...currentSchema, ...parseStores(versionDef.stores) };
        continue;
      }

      if (versionDef.version > newVersion) {
        break;
      }

      const newSchema = { ...currentSchema, ...parseStores(versionDef.stores) };
      const changes = diffSchemas(currentSchema, newSchema);

      for (const change of changes) {
        this.applySchemaChange(db, transaction, change, newSchema);
      }

      if (versionDef.upgrade) {
        await this.runUpgradeFunction(db, transaction, versionDef.upgrade);
      }

      currentSchema = newSchema;
    }
  }

  /**
   * Apply a single schema change during upgrade.
   */
  private applySchemaChange(
    db: IDBDatabase,
    transaction: IDBTransaction,
    change: SchemaChange,
    schema: DatabaseSchema,
  ): void {
    switch (change.type) {
      case "add-table": {
        const tableSchema = schema[change.tableName];
        if (!tableSchema) {
          throw new SchemaError(`Missing schema for table "${change.tableName}"`);
        }

        const storeOptions: IDBObjectStoreParameters = {};
        if (tableSchema.primaryKey.keyPath) {
          storeOptions.keyPath = tableSchema.primaryKey.keyPath;
        }
        if (tableSchema.primaryKey.auto) {
          storeOptions.autoIncrement = true;
        }

        const store = db.createObjectStore(change.tableName, storeOptions);
        for (const idx of tableSchema.indexes) {
          if (idx.keyPath) {
            store.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
          }
        }
        break;
      }

      case "delete-table":
        db.deleteObjectStore(change.tableName);
        break;

      case "add-index": {
        if (!change.indexName || !change.spec?.keyPath) {
          throw new SchemaError(`Invalid add-index change for table "${change.tableName}"`);
        }
        const store = transaction.objectStore(change.tableName);
        store.createIndex(change.indexName, change.spec.keyPath, {
          unique: change.spec.unique,
        });
        break;
      }

      case "delete-index": {
        if (!change.indexName) {
          throw new SchemaError(`Invalid delete-index change for table "${change.tableName}"`);
        }
        const store = transaction.objectStore(change.tableName);
        store.deleteIndex(change.indexName);
        break;
      }

      case "change-primary-key":
        throw new SchemaError(
          `Cannot change primary key of table "${change.tableName}". ` +
            "Delete and recreate the table instead.",
        );
    }
  }

  /**
   * Run a user-provided upgrade function with the proper transaction context.
   */
  private async runUpgradeFunction(
    db: IDBDatabase,
    transaction: IDBTransaction,
    upgrade: (tx: TransactionContext) => Promise<void> | void,
  ): Promise<void> {
    const tempCore = createIDBCore(db, this.state.schemas);
    const state: TransactionState = {
      coreTrans: {
        mode: "readwrite",
        tables: Array.from(this.state.schemas.keys()),
        idbTransaction: transaction,
        abort: () => transaction.abort(),
        commit: () => {
          // commit() during upgrade transactions is a no-op
          // The upgrade transaction auto-commits when complete
        },
      },
      core: tempCore,
      active: true,
      completion: Promise.resolve(),
    };

    const txContext = new TransactionContext(state, (name, state) =>
      createTable(tempCore.table(name), () => state.coreTrans, this.getTableHooks(name)),
    );

    await upgrade(txContext);
  }

  /**
   * Set up table proxies on the database instance.
   */
  private setupTableProxies(): void {
    for (const tableName of this.state.schemas.keys()) {
      if (!(tableName in this)) {
        Object.defineProperty(this, tableName, {
          get: () => this.table(tableName),
          configurable: true,
        });
      }
    }
  }

  /**
   * Close the database.
   */
  close(): void {
    const wasOpen = this.state.isOpen;

    if (this.state.idbDatabase) {
      this.state.idbDatabase.close();
    }
    this.state.isOpen = false;
    this.state.idbDatabase = undefined;
    this.state.core = undefined;

    // Emit close event (IDB onclose only fires on external close)
    if (wasOpen) {
      this.events.emit("close");
    }
  }

  /**
   * Delete the database.
   */
  async delete(): Promise<void> {
    this.close();

    const indexedDB = getIndexedDB();
    if (!indexedDB) {
      throw new MissingAPIError("IndexedDB is not available");
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(mapError(request.error));
      request.onblocked = () => reject(new BlockedError("Delete blocked by open connection"));
    });
  }

  /**
   * Check if database is open.
   */
  get isOpen(): boolean {
    return this.state.isOpen;
  }

  // ========================================
  // Table access
  // ========================================

  /**
   * Get a table by name.
   */
  table<T = unknown, TKey = unknown>(name: string): Table<T, TKey> {
    const core = this.getCore();
    const coreTable = core.table(name);
    const hooks = this.getTableHooks<T, TKey>(name);

    return createTable(coreTable, () => this.getImplicitTransaction([name], "readwrite"), hooks);
  }

  /**
   * Get or create table hooks.
   */
  private getTableHooks<T, TKey>(name: string): TableHooks<T, TKey> {
    let hooks = this.state.tableHooks.get(name);
    if (!hooks) {
      hooks = createTableHooks();
      this.state.tableHooks.set(name, hooks);
    }
    return hooks as TableHooks<T, TKey>;
  }

  /**
   * Get an implicit transaction for single-table operations.
   * Note: getCore() must have been called before this to verify db is open.
   */
  private getImplicitTransaction(tables: string[], mode: TransactionMode): DBCoreTransaction {
    // Create a new transaction for each operation
    // This is called from table() which already verified the db is open
    const core = this.state.core;
    if (!core) {
      throw new InvalidStateError("Database is not open");
    }
    return core.transaction(tables, mode);
  }

  /**
   * Ensure the database is open and return the DBCore.
   * This combines the open check with core access, eliminating the need for !.
   */
  private getCore(): DBCore {
    if (!this.state.isOpen || !this.state.core) {
      throw new InvalidStateError("Database is not open. Call open() first.");
    }
    return this.state.core;
  }

  /**
   * Get the latest version number from the versions array.
   * Throws if no versions are defined.
   */
  private getLatestVersionNumber(): number {
    const lastVersion = this.versions.at(-1);
    if (!lastVersion) {
      throw new SchemaError("No schema versions defined");
    }
    return lastVersion.version;
  }

  // ========================================
  // Transactions
  // ========================================

  /**
   * Execute a function within an explicit transaction.
   *
   * @param mode - Transaction mode: "r" | "readonly" | "rw" | "readwrite"
   * @param tables - Tables to include in the transaction
   * @param fn - Function to execute within the transaction
   * @param options - Transaction options (IndexedDB 3.0 features)
   * @param options.durability - Durability hint: "default" | "strict" | "relaxed"
   */
  async transaction<T>(
    mode: TxMode,
    tables: Table<unknown, unknown>[] | string[],
    fn: (tx: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const core = this.getCore();
    const tableNames = tables.map((t) => (typeof t === "string" ? t : t.name));

    return executeTransaction(
      core,
      tableNames,
      mode,
      async (state) => {
        const txContext = new TransactionContext(state, (name, state) =>
          createTable(core.table(name), () => state.coreTrans, this.getTableHooks(name)),
        );

        return fn(txContext);
      },
      options,
    );
  }

  // ========================================
  // Events
  // ========================================

  /**
   * Subscribe to a database event.
   */
  on<K extends keyof DatabaseEvents & string>(
    event: K,
    listener: (...args: DatabaseEvents[K]) => void,
  ): () => void {
    return this.events.on(event, listener);
  }

  // ========================================
  // Utility
  // ========================================

  /**
   * Get all table names.
   */
  get tables(): string[] {
    return Array.from(this.state.schemas.keys());
  }

  /**
   * Get the current version number.
   */
  get verno(): number {
    const lastVersion = this.versions.at(-1);
    return lastVersion?.version ?? 0;
  }

  // ========================================
  // Middleware
  // ========================================

  /**
   * Register middleware to wrap database operations.
   * Middleware is applied in level order (lowest first, closest to IndexedDB).
   *
   * Follows Dexie.js middleware pattern:
   * - `stack: "dbcore"` identifies this as a DBCore middleware
   * - `create()` receives the downstream DBCore and returns a partial DBCore
   * - `level` controls execution order (lower = closer to IndexedDB, default: 10)
   * - `name` allows middleware to be replaced via `unuse({stack, name})`
   */
  use(middleware: Middleware): this {
    // If middleware has a name, replace any existing middleware with same name
    if (middleware.name) {
      this.middleware = this.middleware.filter((m) => m.name !== middleware.name);
    }
    this.middleware.push(middleware);
    // Sort by level (lowest first) - default level is 10
    this.middleware.sort((a, b) => (a.level ?? 10) - (b.level ?? 10));

    // If database is already open, rebuild the core with new middleware
    if (this.state.isOpen && this.state.idbDatabase) {
      this.state.core = this.buildCore(this.state.idbDatabase);
    }

    return this;
  }

  /**
   * Unregister middleware.
   * Can pass the middleware instance or an object with {stack, name} to match by name.
   */
  unuse(
    middleware:
      | Middleware
      | { stack: "dbcore"; name: string; create?: (downCore: DBCore) => Partial<DBCore> },
  ): this {
    if ("create" in middleware && typeof middleware.create === "function") {
      // Passed middleware instance - find by reference or name
      const idx = this.middleware.indexOf(middleware as Middleware);
      if (idx !== -1) {
        this.middleware.splice(idx, 1);
      } else if (middleware.name) {
        this.middleware = this.middleware.filter((m) => m.name !== middleware.name);
      }
    } else if (middleware.name) {
      // Passed {stack, name} - find by name
      this.middleware = this.middleware.filter((m) => m.name !== middleware.name);
    }

    // If database is already open, rebuild the core without the middleware
    if (this.state.isOpen && this.state.idbDatabase) {
      this.state.core = this.buildCore(this.state.idbDatabase);
    }

    return this;
  }

  /**
   * Build the DBCore with middleware applied.
   * Follows Dexie.js pattern: each middleware's create() returns a partial DBCore
   * that is merged with the downstream core.
   */
  private buildCore(db: IDBDatabase): DBCore {
    // Start with the base IDB core
    let core: DBCore = createIDBCore(db, this.state.schemas);

    // Built-in middleware:
    // - Cache middleware (level -1): Caches reads within transactions
    // - Hooks middleware (level 0): Fires table hooks for CRUD operations
    const builtInMiddleware = [
      createCacheMiddleware(),
      createHooksMiddleware(this.state.tableHooks),
    ];

    // Combine built-in and user middleware, sorted by level
    const allMiddleware = [...builtInMiddleware, ...this.middleware].sort(
      (a, b) => (a.level ?? 10) - (b.level ?? 10),
    );

    // Apply middleware in level order (lowest to highest)
    // This means lowest level middleware is closest to IndexedDB
    // Each middleware returns a partial DBCore that is merged with the downstream
    for (const mw of allMiddleware) {
      const partialCore = mw.create(core);
      const downCore = core;
      // Merge partial onto a new object that delegates to downCore for missing methods
      core = {
        stack: partialCore.stack ?? downCore.stack,
        schema: partialCore.schema ?? downCore.schema,
        table: partialCore.table?.bind(partialCore) ?? downCore.table.bind(downCore),
        transaction:
          partialCore.transaction?.bind(partialCore) ?? downCore.transaction.bind(downCore),
      };
    }

    return core;
  }

  // ========================================
  // Browser compatibility
  // ========================================

  /**
   * Set up bfcache (back/forward cache) handling.
   * Closes the database when page is persisted to bfcache,
   * and re-opens it when restored.
   */
  setupBfCacheHandling(): this {
    if (typeof addEventListener === "undefined") {
      return this;
    }

    addEventListener("pagehide", (event) => {
      if ((event as PageTransitionEvent).persisted) {
        // Page is being cached - close the database but allow auto-reopen
        this.close();
      }
    });

    addEventListener("pageshow", (event) => {
      if ((event as PageTransitionEvent).persisted) {
        // Page was restored from cache
        // NOTE: Database must be manually reopened with open() before use
        // For reactivity: trigger observers to re-fetch (when implemented)
        this._requery();
      }
    });

    return this;
  }

  /**
   * Trigger observers to re-fetch data.
   * This is a placeholder for future reactivity support.
   * @internal
   */
  _requery(): void {
    // Placeholder for future live query support
    // When implemented, this will notify all active observers to re-run their queries
  }
}

/**
 * Create a new LessDB instance.
 */
export function createLessDB(name: string): LessDB {
  return new LessDB(name);
}
