/**
 * Transaction class - provides a user-friendly transaction API.
 */

import type { DBCore, DBCoreTransaction, TransactionMode } from './dbcore/index.js';
import type { Table } from './table.js';
import { AbortError, InvalidTableError } from './errors/index.js';

/**
 * Transaction modes (aliases supported).
 */
export type TxMode = 'r' | 'readonly' | 'rw' | 'readwrite';

/**
 * Normalize transaction mode to standard form.
 */
export function normalizeMode(mode: TxMode): TransactionMode {
  return mode === 'r' || mode === 'readonly' ? 'readonly' : 'readwrite';
}

/**
 * High-level transaction interface.
 */
export interface Transaction {
  /** Transaction mode */
  readonly mode: TransactionMode;
  /** Tables in this transaction */
  readonly tables: string[];
  /** Whether the transaction is still active */
  readonly active: boolean;
  /** Abort the transaction */
  abort(): void;
}

/**
 * Internal transaction state.
 */
export interface TransactionState {
  /** The DBCore transaction */
  coreTrans: DBCoreTransaction;
  /** The DBCore instance */
  core: DBCore;
  /** Whether the transaction is active */
  active: boolean;
  /** Promise that resolves when transaction completes */
  completion: Promise<void>;
  /** Error if transaction failed */
  error?: Error;
}

/**
 * Create a transaction state object.
 */
export function createTransactionState(
  core: DBCore,
  tableNames: string[],
  mode: TransactionMode
): TransactionState {
  const coreTrans = core.transaction(tableNames, mode);

  // Create completion promise that tracks the IDB transaction
  const completion = new Promise<void>((resolve, reject) => {
    const idbTrans = coreTrans.idbTransaction;

    idbTrans.oncomplete = () => {
      state.active = false;
      resolve();
    };

    idbTrans.onerror = () => {
      state.active = false;
      state.error = idbTrans.error ?? new AbortError('Transaction failed');
      reject(state.error);
    };

    idbTrans.onabort = () => {
      state.active = false;
      state.error = state.error ?? new AbortError('Transaction aborted');
      reject(state.error);
    };
  });

  const state: TransactionState = {
    coreTrans,
    core,
    active: true,
    completion,
  };

  return state;
}

/**
 * Execute a function within a transaction.
 *
 * @param core - The DBCore instance
 * @param tableNames - Tables to include in transaction
 * @param mode - Transaction mode
 * @param fn - Function to execute
 * @returns Result of the function
 */
export async function executeTransaction<T>(
  core: DBCore,
  tableNames: string[],
  mode: TxMode,
  fn: (state: TransactionState) => Promise<T>
): Promise<T> {
  const normalizedMode = normalizeMode(mode);
  const state = createTransactionState(core, tableNames, normalizedMode);

  try {
    // Execute the user's function
    const result = await fn(state);

    // Wait for transaction to complete
    await state.completion;

    return result;
  } catch (error) {
    // If the transaction is still active, abort it
    if (state.active) {
      try {
        state.coreTrans.abort();
      } catch {
        // Ignore abort errors
      }
    }

    // Wait for transaction to finish aborting (ignore the rejection)
    await state.completion.catch(() => {});

    throw error;
  }
}

/**
 * Transaction context for use within transaction callbacks.
 */
export class TransactionContext implements Transaction {
  private state: TransactionState;
  private tableCache = new Map<string, Table<unknown, unknown>>();
  private tableFactory: (name: string, state: TransactionState) => Table<unknown, unknown>;

  constructor(
    state: TransactionState,
    tableFactory: (name: string, state: TransactionState) => Table<unknown, unknown>
  ) {
    this.state = state;
    this.tableFactory = tableFactory;
  }

  get mode(): TransactionMode {
    return this.state.coreTrans.mode;
  }

  get tables(): string[] {
    return this.state.coreTrans.tables;
  }

  get active(): boolean {
    return this.state.active;
  }

  abort(): void {
    if (this.state.active) {
      this.state.coreTrans.abort();
      this.state.active = false;
    }
  }

  /**
   * Get a table within this transaction.
   */
  table<T, TKey = unknown>(name: string): Table<T, TKey> {
    if (!this.tables.includes(name)) {
      throw new InvalidTableError(`Table "${name}" is not part of this transaction`);
    }

    let table = this.tableCache.get(name);
    if (!table) {
      table = this.tableFactory(name, this.state);
      this.tableCache.set(name, table);
    }

    return table as Table<T, TKey>;
  }
}
