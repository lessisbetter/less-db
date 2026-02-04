/**
 * Unit tests for case-insensitive cursor jumping algorithm.
 *
 * These tests verify the algorithm logic directly without going through
 * the full database stack.
 */

import { describe, it, expect } from "vitest";
import {
  createEqualsIgnoreCaseAlgorithm,
  createStartsWithIgnoreCaseAlgorithm,
  createAnyOfIgnoreCaseAlgorithm,
} from "../src/ignore-case-helpers.js";

describe("ignore-case-helpers", () => {
  describe("createEqualsIgnoreCaseAlgorithm", () => {
    it("returns correct range bounds for simple word", () => {
      const { lowerBound, upperBound } = createEqualsIgnoreCaseAlgorithm("hello");

      expect(lowerBound).toBe("HELLO");
      expect(upperBound).toBe("hello");
    });

    it("returns correct range bounds for mixed case input", () => {
      const { lowerBound, upperBound } = createEqualsIgnoreCaseAlgorithm("HeLLo");

      // Should normalize to uppercase/lowercase regardless of input
      expect(lowerBound).toBe("HELLO");
      expect(upperBound).toBe("hello");
    });

    it("algorithm returns true for exact match (lowercase)", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("hello");

      expect(algorithm("hello", null, null)).toBe(true);
    });

    it("algorithm returns true for exact match (uppercase)", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("hello");

      expect(algorithm("HELLO", null, null)).toBe(true);
    });

    it("algorithm returns true for mixed case match", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("hello");

      expect(algorithm("HeLLo", null, null)).toBe(true);
      expect(algorithm("hELLO", null, null)).toBe(true);
      expect(algorithm("Hello", null, null)).toBe(true);
    });

    it("algorithm returns false for non-string keys", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("hello");

      expect(algorithm(123, null, null)).toBe(false);
      expect(algorithm(null, null, null)).toBe(false);
      expect(algorithm(undefined, null, null)).toBe(false);
      expect(algorithm({ name: "hello" }, null, null)).toBe(false);
    });

    it("algorithm returns jump key for non-matching string before range", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("hello");

      // "HAaaa" is before "HELLO" - should jump to next possible
      const result = algorithm("HAaaa", null, null);
      expect(typeof result).toBe("string");
      expect(result).not.toBe("HAaaa"); // Should jump to a different key
    });

    it("algorithm returns null for non-matching string after range", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("hello");

      // "zzzz" is after "hello" - no more possible matches
      const result = algorithm("zzzz", null, null);
      expect(result).toBe(null);
    });

    it("algorithm handles single character", () => {
      const { algorithm, lowerBound, upperBound } = createEqualsIgnoreCaseAlgorithm("a");

      expect(lowerBound).toBe("A");
      expect(upperBound).toBe("a");
      expect(algorithm("a", null, null)).toBe(true);
      expect(algorithm("A", null, null)).toBe(true);
      expect(algorithm("b", null, null)).toBe(null); // past range
    });

    it("algorithm handles empty string by using equals", () => {
      // Empty string case is handled at WhereClause level, not here
      // But the algorithm should still work
      const { algorithm, lowerBound, upperBound } = createEqualsIgnoreCaseAlgorithm("");

      expect(lowerBound).toBe("");
      expect(upperBound).toBe("");
      expect(algorithm("", null, null)).toBe(true);
      expect(algorithm("a", null, null)).toBe(null);
    });
  });

  describe("createStartsWithIgnoreCaseAlgorithm", () => {
    it("returns correct range bounds for prefix", () => {
      const { lowerBound, upperBound } = createStartsWithIgnoreCaseAlgorithm("hello");

      expect(lowerBound).toBe("HELLO");
      // Upper bound includes high suffix for startsWith
      expect(upperBound).toBe("hello\uffff");
    });

    it("algorithm returns true for prefix match", () => {
      const { algorithm } = createStartsWithIgnoreCaseAlgorithm("hello");

      expect(algorithm("hello", null, null)).toBe(true);
      expect(algorithm("HELLO", null, null)).toBe(true);
      expect(algorithm("HelloWorld", null, null)).toBe(true);
      expect(algorithm("HELLO WORLD", null, null)).toBe(true);
      expect(algorithm("hellooooo", null, null)).toBe(true);
    });

    it("algorithm handles prefix shorter than key", () => {
      const { algorithm } = createStartsWithIgnoreCaseAlgorithm("he");

      expect(algorithm("hello", null, null)).toBe(true);
      expect(algorithm("HELLO", null, null)).toBe(true);
      expect(algorithm("HE", null, null)).toBe(true);
      expect(algorithm("he", null, null)).toBe(true);
    });

    it("algorithm returns false/jump for non-matching strings", () => {
      const { algorithm } = createStartsWithIgnoreCaseAlgorithm("hello");

      // "Help" starts with "Hel" but not "Hello"
      const result = algorithm("Help", null, null);
      // Should either return false or a jump key (not true)
      expect(result).not.toBe(true);
    });
  });

  describe("createAnyOfIgnoreCaseAlgorithm", () => {
    it("returns correct range bounds for multiple values", () => {
      const { lowerBound, upperBound } = createAnyOfIgnoreCaseAlgorithm(["apple", "banana"]);

      // Should span from first upper to last lower
      expect(lowerBound).toBe("APPLE");
      expect(upperBound).toBe("banana");
    });

    it("algorithm returns true for any matching value", () => {
      const { algorithm } = createAnyOfIgnoreCaseAlgorithm(["apple", "banana"]);

      expect(algorithm("apple", null, null)).toBe(true);
      expect(algorithm("APPLE", null, null)).toBe(true);
      expect(algorithm("ApPlE", null, null)).toBe(true);
      expect(algorithm("banana", null, null)).toBe(true);
      expect(algorithm("BANANA", null, null)).toBe(true);
      expect(algorithm("BaNaNa", null, null)).toBe(true);
    });

    it("algorithm returns false/jump for non-matching values", () => {
      const { algorithm } = createAnyOfIgnoreCaseAlgorithm(["apple", "banana"]);

      // "cherry" doesn't match any
      const result = algorithm("cherry", null, null);
      expect(result).not.toBe(true);
    });

    it("handles single value (same as equals)", () => {
      const { algorithm, lowerBound, upperBound } = createAnyOfIgnoreCaseAlgorithm(["hello"]);

      expect(lowerBound).toBe("HELLO");
      expect(upperBound).toBe("hello");
      expect(algorithm("hello", null, null)).toBe(true);
      expect(algorithm("HELLO", null, null)).toBe(true);
    });

    it("handles values with overlapping ranges", () => {
      const { algorithm } = createAnyOfIgnoreCaseAlgorithm(["abc", "abd"]);

      expect(algorithm("abc", null, null)).toBe(true);
      expect(algorithm("ABC", null, null)).toBe(true);
      expect(algorithm("abd", null, null)).toBe(true);
      expect(algorithm("ABD", null, null)).toBe(true);
      expect(algorithm("abe", null, null)).not.toBe(true); // doesn't match
    });
  });

  describe("cursor jumping behavior", () => {
    it("jumps over non-matching keys efficiently", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("test");

      // When we see a non-matching key, we should get a jump target
      const jumpTo = algorithm("TAAA", null, null);

      // Should jump to something >= "TAAA" and closer to "TEST"
      expect(typeof jumpTo).toBe("string");
      if (typeof jumpTo === "string") {
        expect(jumpTo > "TAAA").toBe(true);
      }
    });

    it("returns null when past all possible matches", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("abc");

      // "zzz" is way past "abc" - no point continuing
      expect(algorithm("zzz", null, null)).toBe(null);
    });

    it("handles boundary between upper and lower case ranges", () => {
      const { algorithm } = createEqualsIgnoreCaseAlgorithm("hello");

      // Test keys at various points in the range
      // "HELLO" should match
      expect(algorithm("HELLO", null, null)).toBe(true);

      // "Hello" is in the middle of the case range
      expect(algorithm("Hello", null, null)).toBe(true);

      // "hello" is at the end of the range
      expect(algorithm("hello", null, null)).toBe(true);

      // Keys just before/after the matching keys
      const beforeHello = algorithm("HELLN", null, null);
      expect(beforeHello).not.toBe(true); // Should jump or return false

      const afterHello = algorithm("hellp", null, null);
      expect(afterHello).toBe(null); // Past the range
    });
  });
});
