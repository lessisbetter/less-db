import { describe, it, expect } from "vitest";
import {
  getIndexedDB,
  getIDBKeyRange,
  safariMultiStoreFix,
  fixOldVersion,
  hasWorkingGetAll,
  getMaxKey,
  getMinKey,
  getValueType,
  fixUndefinedKey,
  compareKeys,
  browserEnv,
  safeStopPropagation,
  safePreventDefault,
} from "./index.js";

describe("compat", () => {
  describe("getIndexedDB", () => {
    it("returns IndexedDB (fake-indexeddb in tests)", () => {
      const idb = getIndexedDB();
      expect(idb).toBeDefined();
    });
  });

  describe("getIDBKeyRange", () => {
    it("returns IDBKeyRange", () => {
      const KeyRange = getIDBKeyRange();
      expect(KeyRange).toBeDefined();
    });
  });

  describe("safariMultiStoreFix", () => {
    it("returns single store as string", () => {
      expect(safariMultiStoreFix(["users"])).toBe("users");
    });

    it("returns multiple stores as array", () => {
      const stores = ["users", "posts"];
      expect(safariMultiStoreFix(stores)).toBe(stores);
    });

    it("returns empty array as array", () => {
      expect(safariMultiStoreFix([])).toEqual([]);
    });
  });

  describe("fixOldVersion", () => {
    it("passes through normal versions", () => {
      expect(fixOldVersion(0)).toBe(0);
      expect(fixOldVersion(1)).toBe(1);
      expect(fixOldVersion(100)).toBe(100);
    });

    it("fixes Safari 8 overflow", () => {
      const overflow = Math.pow(2, 63);
      expect(fixOldVersion(overflow)).toBe(0);
    });

    it("handles edge case near threshold", () => {
      // Note: 2^62 is beyond JS safe integers, so we test with values that work
      const justUnder = Math.pow(2, 62) - Math.pow(2, 10); // Safely under
      const justOver = Math.pow(2, 62) * 1.1; // Safely over
      expect(fixOldVersion(justUnder)).toBe(justUnder);
      expect(fixOldVersion(justOver)).toBe(0);
    });
  });

  describe("hasWorkingGetAll", () => {
    it("returns true in Node environment", () => {
      // In test environment (Node), no navigator
      expect(hasWorkingGetAll()).toBe(true);
    });
  });

  describe("getMaxKey", () => {
    it("returns a valid max key", () => {
      const maxKey = getMaxKey();
      expect(maxKey).toBeDefined();
      // Should be either [[]] or max string
      expect(JSON.stringify(maxKey) === "[[]]" || maxKey === String.fromCharCode(65535)).toBe(true);
    });

    it("returns cached value on subsequent calls", () => {
      const first = getMaxKey();
      const second = getMaxKey();
      expect(first).toBe(second);
    });
  });

  describe("getMinKey", () => {
    it("returns -Infinity", () => {
      expect(getMinKey()).toBe(-Infinity);
    });
  });

  describe("getValueType", () => {
    it("identifies primitives", () => {
      expect(getValueType("hello")).toBe("string");
      expect(getValueType(42)).toBe("number");
      expect(getValueType(3.14)).toBe("number");
      expect(getValueType(true)).toBe("boolean");
      expect(getValueType(false)).toBe("boolean");
    });

    it("identifies null and undefined", () => {
      expect(getValueType(null)).toBe("null");
      expect(getValueType(undefined)).toBe("undefined");
    });

    it("identifies arrays", () => {
      expect(getValueType([])).toBe("array");
      expect(getValueType([1, 2, 3])).toBe("array");
    });

    it("identifies dates", () => {
      expect(getValueType(new Date())).toBe("date");
    });

    it("identifies binary data", () => {
      expect(getValueType(new ArrayBuffer(8))).toBe("binary");
      expect(getValueType(new Uint8Array(8))).toBe("binary");
      expect(getValueType(new Int32Array(4))).toBe("binary");
    });

    it("identifies objects", () => {
      expect(getValueType({})).toBe("object");
      expect(getValueType({ foo: "bar" })).toBe("object");
    });
  });

  describe("fixUndefinedKey", () => {
    it("removes undefined key property", () => {
      const obj = { id: undefined, name: "test" };
      const fixed = fixUndefinedKey(obj, "id");
      expect("id" in fixed).toBe(false);
      expect(fixed.name).toBe("test");
    });

    it("preserves defined key property", () => {
      const obj = { id: 1, name: "test" };
      const fixed = fixUndefinedKey(obj, "id");
      expect(fixed.id).toBe(1);
    });

    it("ignores missing key property", () => {
      const obj = { name: "test" };
      const fixed = fixUndefinedKey(obj, "id");
      expect(fixed).toBe(obj); // Same reference
    });

    it("ignores null keyPath", () => {
      const obj = { id: undefined };
      const fixed = fixUndefinedKey(obj, null);
      expect(fixed).toBe(obj);
    });

    it("ignores dotted keyPath", () => {
      const obj = { "a.b": undefined };
      const fixed = fixUndefinedKey(obj, "a.b");
      expect(fixed).toBe(obj);
    });

    it("does not mutate original", () => {
      const obj = { id: undefined, name: "test" };
      fixUndefinedKey(obj, "id");
      expect("id" in obj).toBe(true);
    });
  });

  describe("compareKeys", () => {
    describe("type ordering", () => {
      it("orders undefined before null", () => {
        expect(compareKeys(undefined, null)).toBe(-1);
        expect(compareKeys(null, undefined)).toBe(1);
      });

      it("orders null before numbers", () => {
        expect(compareKeys(null, 0)).toBe(-1);
        expect(compareKeys(0, null)).toBe(1);
      });

      it("orders numbers before dates", () => {
        expect(compareKeys(0, new Date())).toBe(-1);
        expect(compareKeys(new Date(), 0)).toBe(1);
      });

      it("orders dates before strings", () => {
        expect(compareKeys(new Date(), "")).toBe(-1);
        expect(compareKeys("", new Date())).toBe(1);
      });

      it("orders strings before arrays", () => {
        expect(compareKeys("z", [])).toBe(-1);
        expect(compareKeys([], "a")).toBe(1);
      });
    });

    describe("same type comparison", () => {
      it("compares undefined", () => {
        expect(compareKeys(undefined, undefined)).toBe(0);
      });

      it("compares null", () => {
        expect(compareKeys(null, null)).toBe(0);
      });

      it("compares numbers", () => {
        expect(compareKeys(1, 2)).toBe(-1);
        expect(compareKeys(2, 1)).toBe(1);
        expect(compareKeys(5, 5)).toBe(0);
        expect(compareKeys(-1, 1)).toBe(-1);
        expect(compareKeys(1.5, 1.6)).toBe(-1);
      });

      it("compares dates", () => {
        const earlier = new Date("2020-01-01");
        const later = new Date("2020-12-31");
        expect(compareKeys(earlier, later)).toBe(-1);
        expect(compareKeys(later, earlier)).toBe(1);
        expect(compareKeys(earlier, new Date("2020-01-01"))).toBe(0);
      });

      it("compares strings", () => {
        expect(compareKeys("a", "b")).toBe(-1);
        expect(compareKeys("b", "a")).toBe(1);
        expect(compareKeys("hello", "hello")).toBe(0);
        expect(compareKeys("abc", "abd")).toBe(-1);
      });

      it("compares arrays lexicographically", () => {
        expect(compareKeys([1], [2])).toBe(-1);
        expect(compareKeys([2], [1])).toBe(1);
        expect(compareKeys([1, 2], [1, 2])).toBe(0);
        expect(compareKeys([1, 2], [1, 3])).toBe(-1);
        expect(compareKeys([1], [1, 2])).toBe(-1);
        expect(compareKeys([1, 2], [1])).toBe(1);
      });

      it("compares binary data", () => {
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([1, 2, 4]);
        const c = new Uint8Array([1, 2, 3]);
        const d = new Uint8Array([1, 2]);
        expect(compareKeys(a, b)).toBe(-1);
        expect(compareKeys(b, a)).toBe(1);
        expect(compareKeys(a, c)).toBe(0);
        expect(compareKeys(d, a)).toBe(-1);
        expect(compareKeys(a, d)).toBe(1);
      });
    });

    describe("edge cases", () => {
      it("compares empty arrays", () => {
        expect(compareKeys([], [])).toBe(0);
        expect(compareKeys([], [1])).toBe(-1);
        expect(compareKeys([1], [])).toBe(1);
      });

      it("handles Infinity values", () => {
        expect(compareKeys(Infinity, -Infinity)).toBe(1);
        expect(compareKeys(-Infinity, 0)).toBe(-1);
        expect(compareKeys(Infinity, Infinity)).toBe(0);
        expect(compareKeys(-Infinity, -Infinity)).toBe(0);
      });

      it("handles very large numbers", () => {
        const large = Number.MAX_SAFE_INTEGER;
        const larger = large + 1;
        expect(compareKeys(large, larger)).toBe(-1);
        expect(compareKeys(larger, large)).toBe(1);
      });

      it("handles empty strings", () => {
        expect(compareKeys("", "")).toBe(0);
        expect(compareKeys("", "a")).toBe(-1);
        expect(compareKeys("a", "")).toBe(1);
      });

      it("handles nested arrays", () => {
        expect(compareKeys([1, [2]], [1, [2]])).toBe(0);
        expect(compareKeys([1, [2]], [1, [3]])).toBe(-1);
        expect(compareKeys([[1], 2], [[1], 3])).toBe(-1);
      });

      it("handles empty binary data", () => {
        const empty = new Uint8Array([]);
        const nonEmpty = new Uint8Array([1]);
        expect(compareKeys(empty, empty)).toBe(0);
        expect(compareKeys(empty, nonEmpty)).toBe(-1);
        expect(compareKeys(nonEmpty, empty)).toBe(1);
      });
    });
  });

  describe("browserEnv", () => {
    it("returns consistent values for browser detection", () => {
      // In test environment with fake-indexeddb, navigator may or may not be defined
      // Just verify these don't throw and return booleans
      expect(typeof browserEnv.isNode).toBe("boolean");
      expect(typeof browserEnv.isSafari).toBe("boolean");
      expect(typeof browserEnv.isFirefox).toBe("boolean");
      expect(typeof browserEnv.isChrome).toBe("boolean");
      expect(typeof browserEnv.isEdge).toBe("boolean");
    });
  });

  describe("safeStopPropagation", () => {
    it("calls stopPropagation when available", () => {
      let called = false;
      const event = {
        stopPropagation: () => {
          called = true;
        },
      } as Event;

      safeStopPropagation(event);
      expect(called).toBe(true);
    });

    it("does not throw when stopPropagation is not available", () => {
      const event = {} as Event;
      expect(() => safeStopPropagation(event)).not.toThrow();
    });
  });

  describe("safePreventDefault", () => {
    it("calls preventDefault when available", () => {
      let called = false;
      const event = {
        preventDefault: () => {
          called = true;
        },
      } as Event;

      safePreventDefault(event);
      expect(called).toBe(true);
    });

    it("does not throw when preventDefault is not available", () => {
      const event = {} as Event;
      expect(() => safePreventDefault(event)).not.toThrow();
    });
  });

  describe("compareKeys additional binary tests", () => {
    it("compares ArrayBuffer directly", () => {
      const a = new ArrayBuffer(3);
      const viewA = new Uint8Array(a);
      viewA[0] = 1;
      viewA[1] = 2;
      viewA[2] = 3;

      const b = new ArrayBuffer(3);
      const viewB = new Uint8Array(b);
      viewB[0] = 1;
      viewB[1] = 2;
      viewB[2] = 4;

      expect(compareKeys(a, b)).toBe(-1);
      expect(compareKeys(b, a)).toBe(1);
    });

    it("compares ArrayBuffer with Uint8Array", () => {
      const buf = new ArrayBuffer(3);
      const view = new Uint8Array(buf);
      view[0] = 1;
      view[1] = 2;
      view[2] = 3;

      const arr = new Uint8Array([1, 2, 3]);

      expect(compareKeys(buf, arr)).toBe(0);
    });

    it("compares different TypedArray views", () => {
      const a = new Int8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3]);
      expect(compareKeys(a, b)).toBe(0);
    });
  });
});
