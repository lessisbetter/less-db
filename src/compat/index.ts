/**
 * Browser compatibility layer for IndexedDB.
 *
 * Handles vendor prefixes and browser-specific quirks based on
 * lessons learned from Dexie.js.
 */

declare const globalThis: {
  indexedDB?: IDBFactory;
  mozIndexedDB?: IDBFactory;
  webkitIndexedDB?: IDBFactory;
  msIndexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
  webkitIDBKeyRange?: typeof IDBKeyRange;
  navigator?: Navigator;
};

/**
 * Get the IndexedDB factory, handling vendor prefixes.
 */
export function getIndexedDB(): IDBFactory | undefined {
  if (typeof globalThis === "undefined") return undefined;
  return (
    globalThis.indexedDB ||
    globalThis.mozIndexedDB ||
    globalThis.webkitIndexedDB ||
    globalThis.msIndexedDB
  );
}

/**
 * Get the IDBKeyRange constructor, handling vendor prefixes.
 */
export function getIDBKeyRange(): typeof IDBKeyRange | undefined {
  if (typeof globalThis === "undefined") return undefined;
  return globalThis.IDBKeyRange || globalThis.webkitIDBKeyRange;
}

/**
 * Safari 8 has a bug where transactions with multiple store names fail.
 * This function reduces store names array to a single string when there's only one.
 */
export function safariMultiStoreFix(storeNames: string[]): string | string[] {
  if (storeNames.length === 1) {
    const [first] = storeNames;
    // Destructuring guarantees first exists when length === 1
    return first as string;
  }
  return storeNames;
}

/**
 * Safari 8 reports an invalid oldVersion > 2^62 for new databases.
 * This normalizes it to 0.
 */
export function fixOldVersion(oldVersion: number): number {
  return oldVersion > Math.pow(2, 62) ? 0 : oldVersion;
}

/**
 * Detects if the current browser has a working getAll() method.
 * Safari versions below 604 have a broken getAll().
 */
export function hasWorkingGetAll(): boolean {
  if (typeof navigator === "undefined") return true;
  const ua = navigator.userAgent;

  // Not Safari
  if (!/Safari/.test(ua)) return true;

  // Chrome or Edge (using Safari in UA)
  if (/(Chrome\/|Edge\/)/.test(ua)) return true;

  // Check Safari version
  const match = ua.match(/Safari\/(\d+)/);
  if (match?.[1]) {
    const version = parseInt(match[1], 10);
    return version >= 604;
  }

  return true;
}

/**
 * Cache for max key detection.
 */
let cachedMaxKey: unknown;

/**
 * Gets the maximum key value supported by the browser.
 * Some browsers support [[]] (empty array), others need max string.
 */
export function getMaxKey(): unknown {
  if (cachedMaxKey !== undefined) return cachedMaxKey;

  const IDBKeyRange = getIDBKeyRange();
  if (!IDBKeyRange) {
    cachedMaxKey = String.fromCharCode(65535);
    return cachedMaxKey;
  }

  try {
    IDBKeyRange.only([[]]);
    cachedMaxKey = [[]];
  } catch {
    cachedMaxKey = String.fromCharCode(65535);
  }

  return cachedMaxKey;
}

/**
 * Gets the minimum key value.
 */
export function getMinKey(): unknown {
  return -Infinity;
}

/**
 * Safari has issues with instanceof checks across realms.
 * Use Object.prototype.toString for reliable type checking.
 */
export function getValueType(
  value: unknown,
): "string" | "number" | "boolean" | "undefined" | "null" | "array" | "date" | "binary" | "object" {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return t;
  }

  if (ArrayBuffer.isView(value)) return "binary";

  const tag = Object.prototype.toString.call(value).slice(8, -1);
  switch (tag) {
    case "Array":
      return "array";
    case "Date":
      return "date";
    case "ArrayBuffer":
      return "binary";
    default:
      return "object";
  }
}

/**
 * IndexedDB doesn't accept objects where the primary key property
 * exists but has an undefined value. This removes the property.
 */
export function fixUndefinedKey<T extends object>(obj: T, keyPath: string | null): T {
  if (!keyPath || typeof keyPath !== "string" || keyPath.includes(".")) {
    return obj;
  }

  if ((obj as Record<string, unknown>)[keyPath] === undefined && keyPath in obj) {
    const clone = { ...obj };
    delete (clone as Record<string, unknown>)[keyPath];
    return clone;
  }

  return obj;
}

/**
 * Safely calls stopPropagation if available (Safari 8 compat).
 */
export function safeStopPropagation(event: Event): void {
  if (event.stopPropagation) {
    event.stopPropagation();
  }
}

/**
 * Safely calls preventDefault if available (Safari 8 compat).
 */
export function safePreventDefault(event: Event): void {
  if (event.preventDefault) {
    event.preventDefault();
  }
}

/**
 * Compare two IndexedDB keys.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareKeys(a: unknown, b: unknown): number {
  const typeA = getValueType(a);
  const typeB = getValueType(b);

  // Type order: undefined < null < number < date < string < binary < array
  const typeOrder = ["undefined", "null", "number", "date", "string", "binary", "array"];
  const orderA = typeOrder.indexOf(typeA);
  const orderB = typeOrder.indexOf(typeB);

  if (orderA !== orderB) {
    return orderA < orderB ? -1 : 1;
  }

  // Same type, compare values
  switch (typeA) {
    case "undefined":
    case "null":
      return 0;

    case "number": {
      const numA = a as number;
      const numB = b as number;
      if (numA < numB) return -1;
      if (numA > numB) return 1;
      return 0;
    }

    case "date": {
      const timeA = (a as Date).getTime();
      const timeB = (b as Date).getTime();
      if (timeA < timeB) return -1;
      if (timeA > timeB) return 1;
      return 0;
    }

    case "string": {
      const strA = a as string;
      const strB = b as string;
      if (strA < strB) return -1;
      if (strA > strB) return 1;
      return 0;
    }

    case "binary": {
      const bufA = ArrayBuffer.isView(a)
        ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
        : new Uint8Array(a as ArrayBuffer);
      const bufB = ArrayBuffer.isView(b)
        ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
        : new Uint8Array(b as ArrayBuffer);
      const len = Math.min(bufA.length, bufB.length);
      for (let i = 0; i < len; i++) {
        const byteA = bufA[i];
        const byteB = bufB[i];
        // Loop bounds guarantee these exist, but check satisfies TypeScript
        if (byteA === undefined || byteB === undefined) continue;
        if (byteA < byteB) return -1;
        if (byteA > byteB) return 1;
      }
      if (bufA.length < bufB.length) return -1;
      if (bufA.length > bufB.length) return 1;
      return 0;
    }

    case "array": {
      const arrA = a as unknown[];
      const arrB = b as unknown[];
      const len = Math.min(arrA.length, arrB.length);
      for (let i = 0; i < len; i++) {
        const cmp = compareKeys(arrA[i], arrB[i]);
        if (cmp !== 0) return cmp;
      }
      if (arrA.length < arrB.length) return -1;
      if (arrA.length > arrB.length) return 1;
      return 0;
    }

    default:
      return 0;
  }
}

/**
 * Browser environment detection for conditional features.
 */
export const browserEnv = {
  get isSafari(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  },

  get isFirefox(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Firefox/.test(navigator.userAgent);
  },

  get isChrome(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Chrome/.test(navigator.userAgent);
  },

  get isEdge(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Edg\//.test(navigator.userAgent);
  },

  get isNode(): boolean {
    return typeof navigator === "undefined";
  },
};
