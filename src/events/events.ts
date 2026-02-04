/**
 * Simple event emitter for database events and hooks.
 */

export type Listener<T extends unknown[]> = (...args: T) => void;
export type Unsubscribe = () => void;

/**
 * A subscribable event that can have multiple listeners.
 */
export class Event<T extends unknown[] = []> {
  private listeners: Set<Listener<T>> = new Set();

  /**
   * Subscribe to this event.
   * @returns Unsubscribe function
   */
  subscribe(listener: Listener<T>): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fire the event, calling all listeners.
   */
  fire(...args: T): void {
    for (const listener of this.listeners) {
      try {
        listener(...args);
      } catch (error) {
        // Log but don't stop other listeners
        console.error("Event listener error:", error);
      }
    }
  }

  /**
   * Check if there are any listeners.
   */
  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  /**
   * Get the number of listeners.
   */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Remove all listeners.
   */
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * A hook that can transform values or cancel operations.
 * Similar to Event but with return value handling.
 */
export class Hook<TArgs extends unknown[], TReturn = void> {
  private handlers: Array<(...args: TArgs) => TReturn | void> = [];

  /**
   * Subscribe to this hook.
   * @returns Unsubscribe function
   */
  subscribe(handler: (...args: TArgs) => TReturn | void): Unsubscribe {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  /**
   * Fire the hook, calling all handlers in order.
   * Returns the last non-undefined return value.
   */
  fire(...args: TArgs): TReturn | void {
    let result: TReturn | void = undefined;
    for (const handler of this.handlers) {
      const value = handler(...args);
      if (value !== undefined) {
        result = value;
      }
    }
    return result;
  }

  /**
   * Check if there are any handlers.
   */
  hasHandlers(): boolean {
    return this.handlers.length > 0;
  }

  /**
   * Get the number of handlers.
   */
  get handlerCount(): number {
    return this.handlers.length;
  }

  /**
   * Remove all handlers.
   */
  clear(): void {
    this.handlers.length = 0;
  }
}

/**
 * Event emitter with typed events.
 */
export class EventEmitter<TEvents extends { [K in keyof TEvents]: unknown[] }> {
  private events = new Map<string, Event<unknown[]>>();

  /**
   * Subscribe to an event.
   */
  on<K extends keyof TEvents & string>(event: K, listener: Listener<TEvents[K]>): Unsubscribe {
    let e = this.events.get(event);
    if (!e) {
      e = new Event<unknown[]>();
      this.events.set(event, e);
    }
    return e.subscribe(listener as Listener<unknown[]>);
  }

  /**
   * Emit an event.
   */
  emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): void {
    const e = this.events.get(event);
    if (e) {
      e.fire(...args);
    }
  }

  /**
   * Remove all listeners for an event.
   */
  off<K extends keyof TEvents & string>(event: K): void {
    const e = this.events.get(event);
    if (e) {
      e.clear();
    }
  }

  /**
   * Remove all listeners for all events.
   */
  clear(): void {
    for (const e of this.events.values()) {
      e.clear();
    }
    this.events.clear();
  }
}

/**
 * Database change event data.
 */
export interface DatabaseChange {
  /** The table that was modified */
  table: string;
  /** The type of modification */
  type: "add" | "put" | "delete";
  /** The primary key of the affected item */
  key: unknown;
  /** The new value (for add/put) */
  obj?: unknown;
  /** The old value (for put/delete, if available) */
  oldObj?: unknown;
}

/**
 * Standard database events.
 */
export interface DatabaseEvents {
  /** Fired when the database is ready */
  ready: [];
  /** Fired when another connection is blocking a version upgrade */
  blocked: [event: IDBVersionChangeEvent];
  /** Fired when a version change is detected from another connection */
  versionchange: [event: IDBVersionChangeEvent];
  /** Fired when the database is closed */
  close: [];
  /** Fired when data changes (for reactivity) */
  changes: [changes: DatabaseChange[]];
}

/**
 * Table hook signatures.
 */
export interface TableHooks<T, TKey> {
  /** Called before creating a new record */
  creating: Hook<[key: TKey | undefined, obj: T], void>;
  /** Called after reading a record */
  reading: Hook<[obj: T], T | void>;
  /** Called before updating a record */
  updating: Hook<[changes: Partial<T>, key: TKey, obj: T], void>;
  /** Called before deleting a record */
  deleting: Hook<[key: TKey, obj: T], void>;
}

/**
 * Create a new set of table hooks.
 */
export function createTableHooks<T, TKey>(): TableHooks<T, TKey> {
  return {
    creating: new Hook(),
    reading: new Hook(),
    updating: new Hook(),
    deleting: new Hook(),
  };
}
