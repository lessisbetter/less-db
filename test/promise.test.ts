/**
 * Tests for LessDBPromise - type-based error catching.
 */

import { describe, it, expect, vi } from "vitest";
import { LessDBPromise, wrapPromise, resolvedPromise, rejectedPromise } from "../src/promise.js";
import {
  LessDBError,
  ConstraintError,
  NotFoundError,
  DataError,
  AbortError,
} from "../src/errors/index.js";

describe("LessDBPromise", () => {
  describe("basic Promise behavior", () => {
    it("resolves like a normal Promise", async () => {
      const promise = new LessDBPromise<number>((resolve) => resolve(42));
      const result = await promise;
      expect(result).toBe(42);
    });

    it("rejects like a normal Promise", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new Error("test error")),
      );
      await expect(promise).rejects.toThrow("test error");
    });

    it("chains with then()", async () => {
      const promise = new LessDBPromise<number>((resolve) => resolve(10));
      const result = await promise.then((x) => x * 2).then((x) => x + 1);
      expect(result).toBe(21);
    });

    it("then() returns LessDBPromise", () => {
      const promise = new LessDBPromise<number>((resolve) => resolve(10));
      const chained = promise.then((x) => x * 2);
      expect(chained).toBeInstanceOf(LessDBPromise);
    });

    it("finally() works correctly", async () => {
      const cleanup = vi.fn();
      const promise = new LessDBPromise<number>((resolve) => resolve(42));
      const result = await promise.finally(cleanup);
      expect(result).toBe(42);
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it("finally() returns LessDBPromise", () => {
      const promise = new LessDBPromise<number>((resolve) => resolve(10));
      const chained = promise.finally(() => {});
      expect(chained).toBeInstanceOf(LessDBPromise);
    });
  });

  describe("standard catch()", () => {
    it("catches all errors with standard catch", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new ConstraintError("duplicate")),
      );

      const handler = vi.fn().mockReturnValue("recovered");
      const result = await promise.catch(handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(expect.any(ConstraintError));
      expect(result).toBe("recovered");
    });

    it("catch() returns LessDBPromise", () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new Error("test")),
      );
      const chained = promise.catch(() => 0);
      expect(chained).toBeInstanceOf(LessDBPromise);
    });

    it("handles null handler", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new Error("test")),
      );
      await expect(promise.catch(null)).rejects.toThrow("test");
    });
  });

  describe("type-based catch()", () => {
    it("catches specific error type", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new ConstraintError("duplicate key")),
      );

      const handler = vi.fn().mockReturnValue("handled");
      const result = await promise.catch(ConstraintError, handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(expect.any(ConstraintError));
      expect(result).toBe("handled");
    });

    it("does not catch non-matching error type", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new NotFoundError("not found")),
      );

      const constraintHandler = vi.fn().mockReturnValue("constraint");

      await expect(promise.catch(ConstraintError, constraintHandler)).rejects.toThrow(
        NotFoundError,
      );
      expect(constraintHandler).not.toHaveBeenCalled();
    });

    it("passes non-matching errors to next catch", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new NotFoundError("not found")),
      );

      const constraintHandler = vi.fn().mockReturnValue("constraint");
      const notFoundHandler = vi.fn().mockReturnValue("not found");

      const result = await promise
        .catch(ConstraintError, constraintHandler)
        .catch(NotFoundError, notFoundHandler);

      expect(constraintHandler).not.toHaveBeenCalled();
      expect(notFoundHandler).toHaveBeenCalledOnce();
      expect(result).toBe("not found");
    });

    it("catches parent error class", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new ConstraintError("constraint")),
      );

      const handler = vi.fn().mockReturnValue("handled");
      const result = await promise.catch(LessDBError, handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(result).toBe("handled");
    });

    it("catches base Error class", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new ConstraintError("constraint")),
      );

      const handler = vi.fn().mockReturnValue("handled");
      const result = await promise.catch(Error, handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(result).toBe("handled");
    });

    it("chains multiple type-based catches", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new DataError("bad data")),
      );

      const constraintHandler = vi.fn();
      const notFoundHandler = vi.fn();
      const dataHandler = vi.fn().mockReturnValue("data error handled");

      const result = await promise
        .catch(ConstraintError, constraintHandler)
        .catch(NotFoundError, notFoundHandler)
        .catch(DataError, dataHandler);

      expect(constraintHandler).not.toHaveBeenCalled();
      expect(notFoundHandler).not.toHaveBeenCalled();
      expect(dataHandler).toHaveBeenCalledOnce();
      expect(result).toBe("data error handled");
    });

    it("falls through to generic catch after type-based catches", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new AbortError("aborted")),
      );

      const constraintHandler = vi.fn();
      const genericHandler = vi.fn().mockReturnValue("generic");

      const result = await promise
        .catch(ConstraintError, constraintHandler)
        .catch(genericHandler);

      expect(constraintHandler).not.toHaveBeenCalled();
      expect(genericHandler).toHaveBeenCalledOnce();
      expect(genericHandler).toHaveBeenCalledWith(expect.any(AbortError));
      expect(result).toBe("generic");
    });

    it("type-based catch returns LessDBPromise", () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new ConstraintError("test")),
      );
      const chained = promise.catch(ConstraintError, () => 0);
      expect(chained).toBeInstanceOf(LessDBPromise);
    });

    it("re-throws from type-based handler", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new ConstraintError("original")),
      );

      await expect(
        promise.catch(ConstraintError, () => {
          throw new NotFoundError("re-thrown");
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it("handles async type-based handler", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject(new ConstraintError("constraint")),
      );

      const result = await promise.catch(ConstraintError, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return "async handled";
      });

      expect(result).toBe("async handled");
    });

    it("type-based catch does not catch non-Error rejections", async () => {
      const promise = new LessDBPromise<number>((_, reject) =>
        reject("string error"),
      );

      const errorHandler = vi.fn();
      const genericHandler = vi.fn().mockReturnValue("handled");

      const result = await promise
        .catch(Error, errorHandler)
        .catch(genericHandler);

      expect(errorHandler).not.toHaveBeenCalled();
      expect(genericHandler).toHaveBeenCalledWith("string error");
      expect(result).toBe("handled");
    });
  });

  describe("wrapPromise()", () => {
    it("wraps a resolved Promise", async () => {
      const native = Promise.resolve(42);
      const wrapped = wrapPromise(native);

      expect(wrapped).toBeInstanceOf(LessDBPromise);
      expect(await wrapped).toBe(42);
    });

    it("wraps a rejected Promise", async () => {
      const native = Promise.reject(new ConstraintError("test"));
      const wrapped = wrapPromise(native);

      expect(wrapped).toBeInstanceOf(LessDBPromise);

      const handler = vi.fn().mockReturnValue("handled");
      const result = await wrapped.catch(ConstraintError, handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(result).toBe("handled");
    });

    it("preserves type-based catching on wrapped Promise", async () => {
      const native = Promise.reject(new NotFoundError("not found"));
      const wrapped = wrapPromise(native);

      const constraintHandler = vi.fn();
      const notFoundHandler = vi.fn().mockReturnValue("found it");

      const result = await wrapped
        .catch(ConstraintError, constraintHandler)
        .catch(NotFoundError, notFoundHandler);

      expect(constraintHandler).not.toHaveBeenCalled();
      expect(notFoundHandler).toHaveBeenCalledOnce();
      expect(result).toBe("found it");
    });
  });

  describe("resolvedPromise()", () => {
    it("creates a resolved LessDBPromise", async () => {
      const promise = resolvedPromise(42);
      expect(promise).toBeInstanceOf(LessDBPromise);
      expect(await promise).toBe(42);
    });
  });

  describe("rejectedPromise()", () => {
    it("creates a rejected LessDBPromise", async () => {
      const promise = rejectedPromise(new ConstraintError("test"));
      expect(promise).toBeInstanceOf(LessDBPromise);
      await expect(promise).rejects.toThrow(ConstraintError);
    });

    it("supports type-based catching", async () => {
      const promise = rejectedPromise<number>(new ConstraintError("test"));

      const result = await promise.catch(ConstraintError, () => 99);
      expect(result).toBe(99);
    });
  });

  describe("real-world usage patterns", () => {
    it("simulates db.users.add() with constraint error", async () => {
      // Simulate an add operation that fails with constraint error
      const addUser = (): LessDBPromise<number> => {
        return new LessDBPromise((_, reject) => {
          setTimeout(() => reject(new ConstraintError("Duplicate email")), 0);
        });
      };

      const result = await addUser()
        .catch(ConstraintError, (err) => {
          expect(err.message).toBe("Duplicate email");
          return -1; // Return sentinel value
        })
        .catch(() => -2); // Generic fallback

      expect(result).toBe(-1);
    });

    it("simulates multiple operations with different error types", async () => {
      const operations: LessDBPromise<string>[] = [
        rejectedPromise(new ConstraintError("duplicate")),
        rejectedPromise(new NotFoundError("missing")),
        rejectedPromise(new DataError("invalid")),
      ];

      const results = await Promise.all(
        operations.map((op) =>
          op
            .catch(ConstraintError, () => "constraint")
            .catch(NotFoundError, () => "notfound")
            .catch(DataError, () => "data")
            .catch(() => "unknown"),
        ),
      );

      expect(results).toEqual(["constraint", "notfound", "data"]);
    });
  });
});
