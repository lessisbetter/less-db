/**
 * LessDBPromise - Extended Promise with type-based error catching.
 *
 * Enables Dexie-style error handling:
 * ```typescript
 * db.users.add(user)
 *   .catch(ConstraintError, err => console.log("Duplicate key!"))
 *   .catch(err => console.log("Other error:", err));
 * ```
 */


/**
 * Error constructor type for type-based catching.
 */
type ErrorConstructor<E extends Error = Error> = new (...args: unknown[]) => E;

/**
 * Extended Promise that supports type-based error catching.
 */
export class LessDBPromise<T> extends Promise<T> {
  /**
   * Catch errors of a specific type.
   * @param ErrorType - The error constructor to match
   * @param onrejected - Handler called when error matches the type
   */
  catch<E extends Error, TResult = never>(
    ErrorType: ErrorConstructor<E>,
    onrejected: (error: E) => TResult | PromiseLike<TResult>,
  ): LessDBPromise<T | TResult>;

  /**
   * Catch all errors (standard Promise.catch behavior).
   * @param onrejected - Handler called for any error
   */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): LessDBPromise<T | TResult>;

  /**
   * Implementation of overloaded catch.
   */
  catch<E extends Error, TResult = never>(
    errorTypeOrHandler?:
      | ErrorConstructor<E>
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null,
    onrejected?: (error: E) => TResult | PromiseLike<TResult>,
  ): LessDBPromise<T | TResult> {
    // Type-based catch: .catch(ErrorType, handler)
    // Check if first arg is an Error constructor (has a second argument which is the handler)
    if (
      typeof errorTypeOrHandler === "function" &&
      onrejected !== undefined &&
      (errorTypeOrHandler === Error ||
        errorTypeOrHandler.prototype instanceof Error)
    ) {
      const ErrorType = errorTypeOrHandler as ErrorConstructor<E>;
      const handler = onrejected;

      return this.then(undefined, (error: unknown) => {
        if (error instanceof ErrorType) {
          return handler(error);
        }
        throw error;
      }) as LessDBPromise<T | TResult>;
    }

    // Standard catch: .catch(handler) or .catch(null)
    const handler = errorTypeOrHandler as
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null
      | undefined;
    return super.catch(handler) as LessDBPromise<T | TResult>;
  }

  /**
   * Override then to return LessDBPromise for chaining.
   */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): LessDBPromise<TResult1 | TResult2> {
    return super.then(onfulfilled, onrejected) as LessDBPromise<TResult1 | TResult2>;
  }

  /**
   * Override finally to return LessDBPromise for chaining.
   */
  finally(onfinally?: (() => void) | null): LessDBPromise<T> {
    return super.finally(onfinally) as LessDBPromise<T>;
  }
}

/**
 * Wrap a regular Promise as a LessDBPromise.
 */
export function wrapPromise<T>(promise: Promise<T>): LessDBPromise<T> {
  return new LessDBPromise<T>((resolve, reject) => {
    promise.then(resolve, reject);
  });
}

/**
 * Create a resolved LessDBPromise.
 */
export function resolvedPromise<T>(value: T): LessDBPromise<T> {
  return LessDBPromise.resolve(value) as LessDBPromise<T>;
}

/**
 * Create a rejected LessDBPromise.
 */
export function rejectedPromise<T = never>(error: Error): LessDBPromise<T> {
  return LessDBPromise.reject(error) as LessDBPromise<T>;
}
