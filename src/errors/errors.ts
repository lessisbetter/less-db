/**
 * Base error class for all LessDB errors.
 */
export class LessDBError extends Error {
  /** The inner error that caused this error, if any */
  inner?: Error;

  constructor(message: string, inner?: Error) {
    super(message);
    this.name = "LessDBError";
    this.inner = inner;
    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when a uniqueness constraint is violated (duplicate key).
 */
export class ConstraintError extends LessDBError {
  constructor(message = "Constraint violation", inner?: Error) {
    super(message, inner);
    this.name = "ConstraintError";
  }
}

/**
 * Thrown when a requested item is not found.
 */
export class NotFoundError extends LessDBError {
  constructor(message = "Item not found", inner?: Error) {
    super(message, inner);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when the database is in an invalid state for the operation.
 */
export class InvalidStateError extends LessDBError {
  constructor(message = "Invalid state", inner?: Error) {
    super(message, inner);
    this.name = "InvalidStateError";
  }
}

/**
 * Thrown when an invalid table is referenced.
 */
export class InvalidTableError extends LessDBError {
  constructor(message = "Invalid table", inner?: Error) {
    super(message, inner);
    this.name = "InvalidTableError";
  }
}

/**
 * Thrown when invalid data is provided.
 */
export class DataError extends LessDBError {
  constructor(message = "Invalid data", inner?: Error) {
    super(message, inner);
    this.name = "DataError";
  }
}

/**
 * Thrown when a transaction is aborted.
 */
export class AbortError extends LessDBError {
  constructor(message = "Transaction aborted", inner?: Error) {
    super(message, inner);
    this.name = "AbortError";
  }
}

/**
 * Thrown when a required API is missing (e.g., IndexedDB not available).
 */
export class MissingAPIError extends LessDBError {
  constructor(message = "Required API not available", inner?: Error) {
    super(message, inner);
    this.name = "MissingAPIError";
  }
}

/**
 * Thrown when a schema error occurs.
 */
export class SchemaError extends LessDBError {
  constructor(message = "Schema error", inner?: Error) {
    super(message, inner);
    this.name = "SchemaError";
  }
}

/**
 * Thrown when the database is blocked by another connection.
 */
export class BlockedError extends LessDBError {
  constructor(message = "Database blocked", inner?: Error) {
    super(message, inner);
    this.name = "BlockedError";
  }
}

/**
 * Thrown when a version change event occurs.
 */
export class VersionChangeError extends LessDBError {
  constructor(message = "Version change detected", inner?: Error) {
    super(message, inner);
    this.name = "VersionChangeError";
  }
}

/**
 * Thrown when an operation is attempted on a closed database.
 */
export class DatabaseClosedError extends LessDBError {
  constructor(message = "Database has been closed", inner?: Error) {
    super(message, inner);
    this.name = "DatabaseClosedError";
  }
}

/**
 * Thrown when data cannot be cloned for storage in IndexedDB.
 */
export class DataCloneError extends LessDBError {
  constructor(message = "Data could not be cloned for storage", inner?: Error) {
    super(message, inner);
    this.name = "DataCloneError";
  }
}

/**
 * Thrown when an invalid access is attempted.
 */
export class InvalidAccessError extends LessDBError {
  constructor(message = "Invalid access", inner?: Error) {
    super(message, inner);
    this.name = "InvalidAccessError";
  }
}

/**
 * Thrown when opening the database fails.
 */
export class OpenFailedError extends LessDBError {
  constructor(message = "Failed to open database", inner?: Error) {
    super(message, inner);
    this.name = "OpenFailedError";
  }
}

/**
 * Thrown when storage quota is exceeded.
 */
export class QuotaExceededError extends LessDBError {
  constructor(message = "Storage quota exceeded", inner?: Error) {
    super(message, inner);
    this.name = "QuotaExceededError";
  }
}

/**
 * Thrown when a write operation is attempted on a read-only transaction.
 */
export class ReadOnlyError extends LessDBError {
  constructor(message = "Cannot write in read-only transaction", inner?: Error) {
    super(message, inner);
    this.name = "ReadOnlyError";
  }
}

/**
 * Thrown when an operation times out.
 */
export class TimeoutError extends LessDBError {
  constructor(message = "Operation timed out", inner?: Error) {
    super(message, inner);
    this.name = "TimeoutError";
  }
}

/**
 * Thrown when a transaction is no longer active.
 */
export class TransactionInactiveError extends LessDBError {
  constructor(message = "Transaction is no longer active", inner?: Error) {
    super(message, inner);
    this.name = "TransactionInactiveError";
  }
}

/**
 * Maps native IDB/DOMException errors to LessDB errors.
 *
 * Mapped from IndexedDB DOMExceptions:
 * - AbortError, ConstraintError, DataCloneError, DataError, InvalidAccessError,
 *   InvalidStateError, NotFoundError, QuotaExceededError, ReadOnlyError,
 *   TimeoutError, TransactionInactiveError, VersionError
 *
 * LessDB-specific errors (thrown directly by our code, not mapped):
 * - BlockedError, DatabaseClosedError, InvalidTableError, MissingAPIError,
 *   OpenFailedError, SchemaError, VersionChangeError
 */
export function mapError(error: unknown): LessDBError {
  if (error instanceof LessDBError) {
    return error;
  }

  if (error instanceof Error) {
    const name = error.name;
    const message = error.message;

    switch (name) {
      case "AbortError":
        return new AbortError(message, error);
      case "ConstraintError":
        return new ConstraintError(message, error);
      case "DataCloneError":
        return new DataCloneError(message, error);
      case "DataError":
        return new DataError(message, error);
      case "InvalidAccessError":
        return new InvalidAccessError(message, error);
      case "InvalidStateError":
        return new InvalidStateError(message, error);
      case "NotFoundError":
        return new NotFoundError(message, error);
      case "QuotaExceededError":
        return new QuotaExceededError(message, error);
      case "ReadOnlyError":
        return new ReadOnlyError(message, error);
      case "TimeoutError":
        return new TimeoutError(message, error);
      case "TransactionInactiveError":
        return new TransactionInactiveError(message, error);
      case "VersionError":
        return new VersionChangeError(message, error);
      default:
        return new LessDBError(message, error);
    }
  }

  return new LessDBError(String(error));
}
