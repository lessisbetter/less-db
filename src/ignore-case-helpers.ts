/**
 * Helper functions for case-insensitive queries with cursor jumping optimization.
 *
 * These implement the algorithm from Dexie.js that calculates the next possible
 * matching key to jump to, avoiding linear scans through non-matching records.
 */

import type { CursorAlgorithm } from "./dbcore/types.js";

/**
 * Simple string comparison function for forward direction.
 */
function simpleCompare(a: string, b: string): number {
  return a < b ? -1 : a === b ? 0 : 1;
}

/**
 * Simple string comparison function for reverse direction.
 */
function simpleCompareReverse(a: string, b: string): number {
  return a > b ? -1 : a === b ? 0 : 1;
}

/**
 * Calculate the next possible key that could match the case-insensitive pattern.
 * This is the core optimization that enables cursor jumping.
 *
 * @param key - The current key from the cursor
 * @param lowerKey - The lowercase version of the current key
 * @param upperNeedle - The uppercase version of the search needle
 * @param lowerNeedle - The lowercase version of the search needle
 * @param cmp - Comparison function (direction-aware)
 * @param dir - Cursor direction ("next" or "prev")
 * @returns The next key to jump to, or null if no more matches possible
 */
function nextCasing(
  key: string,
  lowerKey: string,
  upperNeedle: string,
  lowerNeedle: string,
  cmp: (a: string, b: string) => number,
  dir: "next" | "prev",
): string | null {
  const length = Math.min(key.length, lowerNeedle.length);
  let llp = -1; // last lower position

  for (let i = 0; i < length; ++i) {
    const lwrKeyChar = lowerKey[i]!;
    if (lwrKeyChar !== lowerNeedle[i]) {
      // Character doesn't match - calculate next possible string
      if (cmp(key[i]!, upperNeedle[i]!) < 0) {
        return key.substring(0, i) + upperNeedle[i] + upperNeedle.substring(i + 1);
      }
      if (cmp(key[i]!, lowerNeedle[i]!) < 0) {
        return key.substring(0, i) + lowerNeedle[i] + upperNeedle.substring(i + 1);
      }
      if (llp >= 0) {
        return key.substring(0, llp) + lowerKey[llp] + upperNeedle.substring(llp + 1);
      }
      return null;
    }
    if (cmp(key[i]!, lwrKeyChar) < 0) {
      llp = i;
    }
  }

  if (length < lowerNeedle.length && dir === "next") {
    return key + upperNeedle.substring(key.length);
  }
  if (length < key.length && dir === "prev") {
    return key.substring(0, upperNeedle.length);
  }
  return llp < 0 ? null : key.substring(0, llp) + lowerNeedle[llp] + upperNeedle.substring(llp + 1);
}

/**
 * State for the case-insensitive algorithm.
 */
interface IgnoreCaseState {
  upperNeedles: string[];
  lowerNeedles: string[];
  compare: (a: string, b: string) => number;
  direction: "next" | "prev";
  nextKeySuffix: string;
  firstPossibleNeedle: number;
}

/**
 * Create a cursor algorithm for case-insensitive matching.
 *
 * @param needles - Array of strings to match (case-insensitive)
 * @param match - Function to check if a lowercase key matches the needles
 * @param suffix - Suffix to append for upper bound (e.g., "" for equals, "\uffff" for startsWith)
 * @param reverse - Whether the query is in reverse direction
 * @returns Object containing the algorithm function and the range bounds
 */
export function createIgnoreCaseAlgorithm(
  needles: string[],
  match: (lowerKey: string, lowerNeedles: string[], firstPossible: number) => boolean,
  suffix: string,
  reverse: boolean = false,
): {
  algorithm: CursorAlgorithm;
  lowerBound: string;
  upperBound: string;
} {
  const dir: "next" | "prev" = reverse ? "prev" : "next";
  const upper = dir === "next" ? (s: string) => s.toUpperCase() : (s: string) => s.toLowerCase();
  const lower = dir === "next" ? (s: string) => s.toLowerCase() : (s: string) => s.toUpperCase();
  const compare = dir === "next" ? simpleCompare : simpleCompareReverse;

  // Sort needles by their lower/upper bounds for efficient iteration
  const needleBounds = needles.map((needle) => ({
    lower: lower(needle),
    upper: upper(needle),
  }));
  needleBounds.sort((a, b) => compare(a.lower, b.lower));

  const upperNeedles = needleBounds.map((nb) => nb.upper);
  const lowerNeedles = needleBounds.map((nb) => nb.lower);
  const needlesLen = needles.length;

  // Calculate range bounds
  const lowerBound = upperNeedles[0]!;
  const upperBound = lowerNeedles[needlesLen - 1]! + suffix;

  // State for the algorithm (mutable for efficiency)
  const state: IgnoreCaseState = {
    upperNeedles,
    lowerNeedles,
    compare,
    direction: dir,
    nextKeySuffix: dir === "next" ? "" : suffix,
    firstPossibleNeedle: 0,
  };

  const algorithm: CursorAlgorithm = (key: unknown): boolean | string | null => {
    if (typeof key !== "string") {
      return false;
    }

    const lowerKey = lower(key);

    // Check if this key matches any needle
    if (match(lowerKey, state.lowerNeedles, state.firstPossibleNeedle)) {
      return true;
    }

    // Key doesn't match - calculate the next possible matching key
    let lowestPossibleCasing: string | null = null;

    for (let i = state.firstPossibleNeedle; i < needlesLen; ++i) {
      const casing = nextCasing(
        key,
        lowerKey,
        state.upperNeedles[i]!,
        state.lowerNeedles[i]!,
        state.compare,
        state.direction,
      );

      if (casing === null && lowestPossibleCasing === null) {
        // No possible match for this needle, skip it in future iterations
        state.firstPossibleNeedle = i + 1;
      } else if (lowestPossibleCasing === null || state.compare(lowestPossibleCasing, casing!) > 0) {
        lowestPossibleCasing = casing;
      }
    }

    if (lowestPossibleCasing !== null) {
      // Jump to the next possible matching key
      return lowestPossibleCasing + state.nextKeySuffix;
    }

    // No more possible matches
    return null;
  };

  return { algorithm, lowerBound, upperBound };
}

/**
 * Create a cursor algorithm for equalsIgnoreCase.
 */
export function createEqualsIgnoreCaseAlgorithm(
  value: string,
  reverse: boolean = false,
): {
  algorithm: CursorAlgorithm;
  lowerBound: string;
  upperBound: string;
} {
  const lowerValue = value.toLowerCase();

  return createIgnoreCaseAlgorithm(
    [value],
    (lowerKey, lowerNeedles) => lowerKey === lowerNeedles[0],
    "", // No suffix for equals
    reverse,
  );
}

/**
 * Create a cursor algorithm for startsWithIgnoreCase.
 */
export function createStartsWithIgnoreCaseAlgorithm(
  prefix: string,
  reverse: boolean = false,
): {
  algorithm: CursorAlgorithm;
  lowerBound: string;
  upperBound: string;
} {
  const lowerPrefix = prefix.toLowerCase();

  return createIgnoreCaseAlgorithm(
    [prefix],
    (lowerKey, lowerNeedles) => lowerKey.startsWith(lowerNeedles[0]!),
    "\uffff", // High suffix for startsWith range
    reverse,
  );
}

/**
 * Create a cursor algorithm for anyOfIgnoreCase.
 */
export function createAnyOfIgnoreCaseAlgorithm(
  values: string[],
  reverse: boolean = false,
): {
  algorithm: CursorAlgorithm;
  lowerBound: string;
  upperBound: string;
} {
  const lowerValuesSet = new Set(values.map((v) => v.toLowerCase()));

  return createIgnoreCaseAlgorithm(
    values,
    (lowerKey, _lowerNeedles, firstPossible) => {
      // For anyOf, check if the key matches any of the values
      return lowerValuesSet.has(lowerKey);
    },
    "", // No suffix for equals
    reverse,
  );
}
