/**
 * Logging middleware - provides observability for DBCore operations.
 *
 * Features:
 * - Logs all DBCore operations with timing information
 * - Configurable log levels (error, warn, info, debug)
 * - Support for custom log handlers
 * - Transaction ID tracking
 * - Operation duration metrics
 */

import type {
  DBCore,
  DBCoreTable,
  DBCoreTransaction,
  DBCoreGetRequest,
  DBCoreGetManyRequest,
  DBCoreQueryRequest,
  DBCoreCountRequest,
  DBCoreMutateRequest,
  DBCoreOpenCursorRequest,
} from "./types.js";

/**
 * Log levels in order of verbosity.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Log entry structure.
 */
export interface LogEntry {
  /** Log level */
  level: LogLevel;
  /** Operation name (e.g., "get", "query", "mutate") */
  operation: string;
  /** Table name */
  table: string;
  /** Transaction ID (for correlation) */
  transactionId: string;
  /** Operation duration in milliseconds */
  durationMs: number;
  /** Additional details about the operation */
  details?: Record<string, unknown>;
  /** Error if the operation failed */
  error?: Error;
  /** Timestamp when operation started */
  timestamp: Date;
}

/**
 * Custom log handler function.
 */
export type LogHandler = (entry: LogEntry) => void;

/**
 * Options for the logging middleware.
 */
export interface LoggingMiddlewareOptions {
  /**
   * Minimum log level to record.
   * Operations are logged at these levels:
   * - debug: All operations with full details
   * - info: All operations with summary details
   * - warn: Slow operations (exceeding slowThresholdMs)
   * - error: Failed operations only
   * Default: "info"
   */
  level?: LogLevel;

  /**
   * Custom log handler. If not provided, logs to console.
   */
  handler?: LogHandler;

  /**
   * Threshold in ms for "slow" operations that trigger warn-level logs.
   * Default: 100ms
   */
  slowThresholdMs?: number;

  /**
   * Whether to include request details in logs.
   * Can be verbose, so disabled by default.
   * Default: false
   */
  includeDetails?: boolean;
}

// Log level priority (higher = more severe)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Default console-based log handler.
 */
function defaultLogHandler(entry: LogEntry): void {
  const prefix = `[LessDB] [${entry.level.toUpperCase()}]`;
  const operation = `${entry.table}.${entry.operation}`;
  const duration = `${entry.durationMs.toFixed(2)}ms`;
  const txId = entry.transactionId.slice(0, 8);

  const message = `${prefix} ${operation} (${duration}) [tx:${txId}]`;

  if (entry.error) {
    console.error(message, entry.error);
  } else if (entry.level === "warn") {
    console.warn(message, entry.details ?? "");
  } else if (entry.level === "debug") {
    console.debug(message, entry.details ?? "");
  } else {
    console.log(message, entry.details ?? "");
  }
}

/**
 * Generate a unique transaction ID.
 */
function generateTransactionId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// WeakMap to store transaction IDs
const transactionIds = new WeakMap<DBCoreTransaction, string>();

/**
 * Get or create a transaction ID.
 */
function getTransactionId(trans: DBCoreTransaction): string {
  let id = transactionIds.get(trans);
  if (!id) {
    id = generateTransactionId();
    transactionIds.set(trans, id);
  }
  return id;
}

/**
 * Create a logged table wrapper.
 */
function createLoggedTable(
  downTable: DBCoreTable,
  options: Required<LoggingMiddlewareOptions>,
): DBCoreTable {
  const { level: minLevel, handler, slowThresholdMs, includeDetails } = options;

  /**
   * Log an operation entry if it meets the minimum level.
   */
  function log(entry: LogEntry): void {
    if (LOG_LEVEL_PRIORITY[entry.level] >= LOG_LEVEL_PRIORITY[minLevel]) {
      handler(entry);
    }
  }

  /**
   * Determine log level based on duration and error.
   */
  function determineLevel(durationMs: number, error?: Error): LogLevel {
    if (error) return "error";
    if (durationMs > slowThresholdMs) return "warn";
    return minLevel === "debug" ? "debug" : "info";
  }

  /**
   * Wrap an async operation with logging.
   */
  async function logOperation<T>(
    operation: string,
    trans: DBCoreTransaction,
    details: Record<string, unknown> | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timestamp = new Date();
    const start = performance.now();
    let error: Error | undefined;

    try {
      return await fn();
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      throw e;
    } finally {
      const durationMs = performance.now() - start;
      const level = determineLevel(durationMs, error);

      log({
        level,
        operation,
        table: downTable.name,
        transactionId: getTransactionId(trans),
        durationMs,
        details: includeDetails ? details : undefined,
        error,
        timestamp,
      });
    }
  }

  return {
    name: downTable.name,
    schema: downTable.schema,

    get(req: DBCoreGetRequest): Promise<unknown> {
      return logOperation("get", req.trans, { key: req.key }, () => downTable.get(req));
    },

    getMany(req: DBCoreGetManyRequest): Promise<unknown[]> {
      return logOperation("getMany", req.trans, { keyCount: req.keys.length }, () =>
        downTable.getMany(req),
      );
    },

    query(req: DBCoreQueryRequest): Promise<{ result: unknown[] }> {
      return logOperation(
        "query",
        req.trans,
        {
          index: req.query.index.name,
          limit: req.limit,
          offset: req.offset,
          reverse: req.reverse,
          values: req.values,
        },
        () => downTable.query(req),
      );
    },

    count(req: DBCoreCountRequest): Promise<number> {
      return logOperation("count", req.trans, { index: req.query.index.name }, () =>
        downTable.count(req),
      );
    },

    openCursor(req: DBCoreOpenCursorRequest) {
      // Log cursor open (not individual iterations)
      return logOperation(
        "openCursor",
        req.trans,
        {
          index: req.query.index.name,
          reverse: req.reverse,
        },
        () => downTable.openCursor(req),
      );
    },

    mutate(req: DBCoreMutateRequest): Promise<{
      numFailures: number;
      failures?: Record<number, Error>;
      results?: unknown[];
      lastKey?: unknown;
    }> {
      const details: Record<string, unknown> = { type: req.type };

      if (req.type === "add" || req.type === "put") {
        details.valueCount = req.values.length;
      } else if (req.type === "delete") {
        details.keyCount = req.keys.length;
      }

      return logOperation("mutate", req.trans, details, () => downTable.mutate(req));
    },
  };
}

/**
 * Create the logging middleware.
 *
 * @param options - Configuration options
 * @returns Middleware that logs all DBCore operations
 *
 * @example
 * ```typescript
 * // Basic usage with console logging
 * db.use(createLoggingMiddleware());
 *
 * // Custom log level
 * db.use(createLoggingMiddleware({ level: "debug" }));
 *
 * // Custom log handler (e.g., send to analytics)
 * db.use(createLoggingMiddleware({
 *   handler: (entry) => analytics.track("db_operation", entry)
 * }));
 *
 * // Warn on slow queries
 * db.use(createLoggingMiddleware({
 *   slowThresholdMs: 50,
 *   level: "warn"
 * }));
 * ```
 */
export function createLoggingMiddleware(options: LoggingMiddlewareOptions = {}): {
  stack: "dbcore";
  name: string;
  level: number;
  create: (downCore: DBCore) => Partial<DBCore>;
} {
  const resolvedOptions: Required<LoggingMiddlewareOptions> = {
    level: options.level ?? "info",
    handler: options.handler ?? defaultLogHandler,
    slowThresholdMs: options.slowThresholdMs ?? 100,
    includeDetails: options.includeDetails ?? false,
  };

  return {
    stack: "dbcore",
    name: "logging",
    level: 10, // Run after most other middleware (higher level = outer)

    create(downCore: DBCore): Partial<DBCore> {
      // Cache tables per-create call to avoid stale references after db reconnection
      const tableCache = new Map<string, DBCoreTable>();

      return {
        table(name: string): DBCoreTable {
          let logged = tableCache.get(name);
          if (!logged) {
            const downTable = downCore.table(name);
            logged = createLoggedTable(downTable, resolvedOptions);
            tableCache.set(name, logged);
          }
          return logged;
        },
      };
    },
  };
}
