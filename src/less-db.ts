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
} from './schema-parser.js';
import {
  type DBCore,
  type DBCoreTransaction,
  type TransactionMode,
  createIDBCore,
} from './dbcore/index.js';
import { Table, createTable } from './table.js';
import {
  executeTransaction,
  TransactionContext,
  type TransactionState,
  type TxMode,
} from './transaction.js';
import {
  EventEmitter,
  createTableHooks,
  type TableHooks,
  type DatabaseEvents,
} from './events/index.js';
import {
  MissingAPIError,
  InvalidStateError,
  SchemaError,
  BlockedError,
  mapError,
} from './errors/index.js';
import { getIndexedDB, fixOldVersion } from './compat/index.js';

/**
 * Version definition for schema migrations.
 */
interface VersionDefinition {
  version: number;
  stores: Record<string, string>;
  upgrade?: (tx: TransactionContext) => Promise<void> | void;
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
            if (prop === 'upgrade') {
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
        }) as LessDB & { upgrade: (fn: (tx: TransactionContext) => Promise<void> | void) => LessDB };
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
      throw new MissingAPIError('IndexedDB is not available');
    }

    if (this.versions.length === 0) {
      throw new SchemaError('No schema versions defined. Call version().stores() first.');
    }

    // Sort versions
    this.versions.sort((a, b) => a.version - b.version);
    const latestVersion = this.versions[this.versions.length - 1].version;

    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.name, latestVersion);

      request.onerror = () => {
        const error = request.error;

        // Chrome UnknownError workaround - retry a few times
        if (error?.name === 'UnknownError' && this.openRetryCount > 0) {
          this.openRetryCount--;
          console.warn('LessDB: Retrying open() after UnknownError');
          this.doOpen().then(resolve, reject);
          return;
        }

        reject(mapError(error));
      };

      request.onblocked = (event) => {
        this.events.emit('blocked', event);
        reject(new BlockedError('Database blocked by another connection'));
      };

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction!;
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
          this.events.emit('versionchange', event);
        };

        db.onclose = () => {
          this.state.isOpen = false;
          this.state.idbDatabase = undefined;
          this.state.core = undefined;
          this.events.emit('close');
        };

        // Initialize state
        this.state.idbDatabase = db;
        this.state.core = createIDBCore(db, this.state.schemas);
        this.state.isOpen = true;

        // Create table proxies
        this.setupTableProxies();

        this.events.emit('ready');
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
    newVersion: number
  ): Promise<void> {
    // Build schema for each version
    let currentSchema: DatabaseSchema = {};

    for (const versionDef of this.versions) {
      if (versionDef.version <= oldVersion) {
        // Build up the schema state to the old version
        currentSchema = { ...currentSchema, ...parseStores(versionDef.stores) };
        continue;
      }

      if (versionDef.version > newVersion) {
        break;
      }

      // Parse new schema
      const newSchema = { ...currentSchema, ...parseStores(versionDef.stores) };
      const changes = diffSchemas(currentSchema, newSchema);

      // Apply schema changes
      for (const change of changes) {
        switch (change.type) {
          case 'add-table': {
            const tableSchema = newSchema[change.tableName];
            const storeOptions: IDBObjectStoreParameters = {};

            if (tableSchema.primaryKey.keyPath) {
              storeOptions.keyPath = tableSchema.primaryKey.keyPath;
            }
            if (tableSchema.primaryKey.auto) {
              storeOptions.autoIncrement = true;
            }

            const store = db.createObjectStore(change.tableName, storeOptions);

            // Create indexes
            for (const idx of tableSchema.indexes) {
              store.createIndex(idx.name, idx.keyPath!, { unique: idx.unique });
            }
            break;
          }

          case 'delete-table':
            db.deleteObjectStore(change.tableName);
            break;

          case 'add-index': {
            const store = transaction.objectStore(change.tableName);
            store.createIndex(change.indexName!, change.spec!.keyPath!, {
              unique: change.spec!.unique,
            });
            break;
          }

          case 'delete-index': {
            const store = transaction.objectStore(change.tableName);
            store.deleteIndex(change.indexName!);
            break;
          }

          case 'change-primary-key':
            throw new SchemaError(
              `Cannot change primary key of table "${change.tableName}". ` +
                'Delete and recreate the table instead.'
            );
        }
      }

      // Run upgrade function if provided
      if (versionDef.upgrade) {
        // Create a temporary core for the upgrade transaction
        const tempCore = createIDBCore(db, this.state.schemas);
        const state: TransactionState = {
          coreTrans: {
            mode: 'readwrite',
            tables: Array.from(this.state.schemas.keys()),
            idbTransaction: transaction,
            abort: () => transaction.abort(),
          },
          core: tempCore,
          active: true,
          completion: Promise.resolve(),
        };

        const txContext = new TransactionContext(state, (name, state) =>
          createTable(
            tempCore.table(name),
            () => state.coreTrans,
            this.getTableHooks(name)
          )
        );

        await versionDef.upgrade(txContext);
      }

      currentSchema = newSchema;
    }
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
      this.events.emit('close');
    }
  }

  /**
   * Delete the database.
   */
  async delete(): Promise<void> {
    this.close();

    const indexedDB = getIndexedDB();
    if (!indexedDB) {
      throw new MissingAPIError('IndexedDB is not available');
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(mapError(request.error));
      request.onblocked = () => reject(new BlockedError('Delete blocked by open connection'));
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
    this.ensureOpen();

    const coreTable = this.state.core!.table(name);
    const hooks = this.getTableHooks<T, TKey>(name);

    return createTable(coreTable, () => this.getImplicitTransaction([name], 'readwrite'), hooks);
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
   */
  private getImplicitTransaction(tables: string[], mode: TransactionMode): DBCoreTransaction {
    // Create a new transaction for each operation
    return this.state.core!.transaction(tables, mode);
  }

  /**
   * Ensure the database is open.
   */
  private ensureOpen(): void {
    if (!this.state.isOpen) {
      throw new InvalidStateError('Database is not open. Call open() first.');
    }
  }

  // ========================================
  // Transactions
  // ========================================

  /**
   * Execute a function within an explicit transaction.
   */
  async transaction<T>(
    mode: TxMode,
    tables: Table<unknown, unknown>[] | string[],
    fn: (tx: TransactionContext) => Promise<T>
  ): Promise<T> {
    this.ensureOpen();

    const tableNames = tables.map((t) => (typeof t === 'string' ? t : t.name));

    return executeTransaction(this.state.core!, tableNames, mode, async (state) => {
      const txContext = new TransactionContext(state, (name, state) =>
        createTable(
          this.state.core!.table(name),
          () => state.coreTrans,
          this.getTableHooks(name)
        )
      );

      return fn(txContext);
    });
  }

  // ========================================
  // Events
  // ========================================

  /**
   * Subscribe to a database event.
   */
  on<K extends keyof DatabaseEvents & string>(
    event: K,
    listener: (...args: DatabaseEvents[K]) => void
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
    if (this.versions.length === 0) return 0;
    return this.versions[this.versions.length - 1].version;
  }
}

/**
 * Create a new LessDB instance.
 */
export function createLessDB(name: string): LessDB {
  return new LessDB(name);
}
