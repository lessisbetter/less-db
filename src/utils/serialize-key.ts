/**
 * Serialize a key for use as a Map key.
 * Fast-paths primitives to avoid JSON.stringify overhead.
 * Uses type prefixes to avoid collisions (e.g., numeric 1 vs string "1").
 *
 * Handles all valid IndexedDB key types:
 * - number, string, Date, ArrayBuffer, Array
 */
export function serializeKey(key: unknown): string {
  const type = typeof key;
  if (type === "number") return `n:${key}`;
  if (type === "string") return `s:${key}`;
  if (type === "boolean") return `b:${key}`;
  if (key === null) return "null";
  if (key === undefined) return "undefined";
  // Arrays (compound keys) - serialize elements recursively
  if (Array.isArray(key)) return `a:${JSON.stringify(key)}`;
  // Dates - use timestamp for reliable comparison
  if (key instanceof Date) return `d:${key.getTime()}`;
  // Fallback for other objects (ArrayBuffer, etc.)
  return `o:${JSON.stringify(key)}`;
}
