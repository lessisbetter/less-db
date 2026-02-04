import { describe, it, expect, vi } from "vitest";
import {
  Event,
  Hook,
  EventEmitter,
  createTableHooks,
  type DatabaseChange,
} from "../../src/events/events.js";

describe("events", () => {
  describe("Event", () => {
    it("fires listeners with arguments", () => {
      const event = new Event<[string, number]>();
      const listener = vi.fn();

      event.subscribe(listener);
      event.fire("hello", 42);

      expect(listener).toHaveBeenCalledWith("hello", 42);
    });

    it("supports multiple listeners", () => {
      const event = new Event<[string]>();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      event.subscribe(listener1);
      event.subscribe(listener2);
      event.fire("test");

      expect(listener1).toHaveBeenCalledWith("test");
      expect(listener2).toHaveBeenCalledWith("test");
    });

    it("returns unsubscribe function", () => {
      const event = new Event<[string]>();
      const listener = vi.fn();

      const unsubscribe = event.subscribe(listener);
      event.fire("first");
      unsubscribe();
      event.fire("second");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("first");
    });

    it("calls all listeners even when some throw, then throws AggregateError", () => {
      const event = new Event<[]>();
      const errorListener = vi.fn(() => {
        throw new Error("test error");
      });
      const normalListener = vi.fn();

      event.subscribe(errorListener);
      event.subscribe(normalListener);

      expect(() => event.fire()).toThrow(AggregateError);
      expect(errorListener).toHaveBeenCalled();
      expect(normalListener).toHaveBeenCalled(); // Still called despite error
    });

    it("throws AggregateError with all listener errors and helpful message", () => {
      const event = new Event<[]>();

      event.subscribe(() => {
        throw new Error("error 1");
      });
      event.subscribe(() => {
        throw new Error("error 2");
      });

      try {
        event.fire();
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AggregateError);
        const aggError = e as AggregateError;
        expect(aggError.errors).toHaveLength(2);
        expect(aggError.errors[0].message).toBe("error 1");
        expect(aggError.errors[1].message).toBe("error 2");
        expect(aggError.message).toContain("2 event listener(s) threw errors");
        expect(aggError.message).toContain("First: error 1");
      }
    });

    it("converts non-Error throws to Error instances", () => {
      const event = new Event<[]>();

      event.subscribe(() => {
        throw "string error";
      });

      try {
        event.fire();
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AggregateError);
        const aggError = e as AggregateError;
        expect(aggError.errors[0]).toBeInstanceOf(Error);
        expect(aggError.errors[0].message).toBe("string error");
      }
    });

    it("reports hasListeners correctly", () => {
      const event = new Event();

      expect(event.hasListeners()).toBe(false);

      const unsub = event.subscribe(() => {});
      expect(event.hasListeners()).toBe(true);

      unsub();
      expect(event.hasListeners()).toBe(false);
    });

    it("reports listenerCount correctly", () => {
      const event = new Event();

      expect(event.listenerCount).toBe(0);

      const unsub1 = event.subscribe(() => {});
      expect(event.listenerCount).toBe(1);

      const unsub2 = event.subscribe(() => {});
      expect(event.listenerCount).toBe(2);

      unsub1();
      expect(event.listenerCount).toBe(1);

      unsub2();
      expect(event.listenerCount).toBe(0);
    });

    it("clears all listeners", () => {
      const event = new Event();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      event.subscribe(listener1);
      event.subscribe(listener2);
      event.clear();
      event.fire();

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(event.listenerCount).toBe(0);
    });

    it("handles no listeners gracefully", () => {
      const event = new Event<[string]>();
      expect(() => event.fire("test")).not.toThrow();
    });
  });

  describe("Hook", () => {
    it("fires handlers with arguments", () => {
      const hook = new Hook<[string, number]>();
      const handler = vi.fn();

      hook.subscribe(handler);
      hook.fire("hello", 42);

      expect(handler).toHaveBeenCalledWith("hello", 42);
    });

    it("returns last non-undefined value", () => {
      const hook = new Hook<[number], number>();

      hook.subscribe((n) => n * 2);
      hook.subscribe((n) => n * 3);

      const result = hook.fire(5);
      expect(result).toBe(15); // 5 * 3 from last handler
    });

    it("handlers receive original input, not chained values", () => {
      const hook = new Hook<[number], number>();
      const receivedValues: number[] = [];

      hook.subscribe((n) => {
        receivedValues.push(n);
        return n * 2;
      });
      hook.subscribe((n) => {
        receivedValues.push(n);
        return n * 3;
      });

      hook.fire(5);
      // Both handlers receive the original input value
      expect(receivedValues).toEqual([5, 5]);
    });

    it("skips undefined returns", () => {
      const hook = new Hook<[number], number>();

      hook.subscribe((n) => n * 2);
      hook.subscribe(() => undefined); // Returns undefined
      hook.subscribe((n) => n * 3);

      const result = hook.fire(5);
      expect(result).toBe(15); // Last non-undefined
    });

    it("returns undefined when no handlers return", () => {
      const hook = new Hook<[number], number>();

      hook.subscribe(() => undefined);

      const result = hook.fire(5);
      expect(result).toBeUndefined();
    });

    it("returns unsubscribe function", () => {
      const hook = new Hook<[number], number>();
      const handler = vi.fn((n: number) => n * 2);

      const unsubscribe = hook.subscribe(handler);
      hook.fire(5);
      unsubscribe();
      hook.fire(10);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("reports hasHandlers correctly", () => {
      const hook = new Hook();

      expect(hook.hasHandlers()).toBe(false);

      const unsub = hook.subscribe(() => {});
      expect(hook.hasHandlers()).toBe(true);

      unsub();
      expect(hook.hasHandlers()).toBe(false);
    });

    it("reports handlerCount correctly", () => {
      const hook = new Hook();

      expect(hook.handlerCount).toBe(0);

      const unsub1 = hook.subscribe(() => {});
      const unsub2 = hook.subscribe(() => {});
      expect(hook.handlerCount).toBe(2);

      unsub1();
      unsub2();
      expect(hook.handlerCount).toBe(0);
    });

    it("clears all handlers", () => {
      const hook = new Hook<[], number>();
      const handler1 = vi.fn(() => 1);
      const handler2 = vi.fn(() => 2);

      hook.subscribe(handler1);
      hook.subscribe(handler2);
      hook.clear();
      hook.fire();

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it("handles no handlers gracefully", () => {
      const hook = new Hook<[string], number>();
      const result = hook.fire("test");
      expect(result).toBeUndefined();
    });
  });

  describe("EventEmitter", () => {
    interface TestEvents {
      message: [text: string];
      count: [n: number];
      empty: [];
    }

    it("emits events to subscribers", () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = vi.fn();

      emitter.on("message", listener);
      emitter.emit("message", "hello");

      expect(listener).toHaveBeenCalledWith("hello");
    });

    it("supports multiple event types", () => {
      const emitter = new EventEmitter<TestEvents>();
      const messageListener = vi.fn();
      const countListener = vi.fn();

      emitter.on("message", messageListener);
      emitter.on("count", countListener);

      emitter.emit("message", "test");
      emitter.emit("count", 42);

      expect(messageListener).toHaveBeenCalledWith("test");
      expect(countListener).toHaveBeenCalledWith(42);
    });

    it("supports multiple listeners per event", () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on("message", listener1);
      emitter.on("message", listener2);
      emitter.emit("message", "test");

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it("returns unsubscribe function", () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = vi.fn();

      const unsub = emitter.on("message", listener);
      emitter.emit("message", "first");
      unsub();
      emitter.emit("message", "second");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("removes all listeners for specific event with off", () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const otherListener = vi.fn();

      emitter.on("message", listener1);
      emitter.on("message", listener2);
      emitter.on("count", otherListener);

      emitter.off("message");

      emitter.emit("message", "test");
      emitter.emit("count", 42);

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(otherListener).toHaveBeenCalled();
    });

    it("clears all events", () => {
      const emitter = new EventEmitter<TestEvents>();
      const messageListener = vi.fn();
      const countListener = vi.fn();

      emitter.on("message", messageListener);
      emitter.on("count", countListener);

      emitter.clear();

      emitter.emit("message", "test");
      emitter.emit("count", 42);

      expect(messageListener).not.toHaveBeenCalled();
      expect(countListener).not.toHaveBeenCalled();
    });

    it("handles emit with no listeners", () => {
      const emitter = new EventEmitter<TestEvents>();
      expect(() => emitter.emit("message", "test")).not.toThrow();
    });

    it("handles off with no listeners", () => {
      const emitter = new EventEmitter<TestEvents>();
      expect(() => emitter.off("message")).not.toThrow();
    });
  });

  describe("createTableHooks", () => {
    interface User {
      id: number;
      name: string;
    }

    it("creates all hook types", () => {
      const hooks = createTableHooks<User, number>();

      expect(hooks.creating).toBeInstanceOf(Hook);
      expect(hooks.reading).toBeInstanceOf(Hook);
      expect(hooks.updating).toBeInstanceOf(Hook);
      expect(hooks.deleting).toBeInstanceOf(Hook);
    });

    it("creating hook receives key and object", () => {
      const hooks = createTableHooks<User, number>();
      const handler = vi.fn();

      hooks.creating.subscribe(handler);
      hooks.creating.fire(1, { id: 1, name: "Alice" });

      expect(handler).toHaveBeenCalledWith(1, { id: 1, name: "Alice" });
    });

    it("reading hook can transform objects", () => {
      const hooks = createTableHooks<User, number>();

      hooks.reading.subscribe((obj) => ({
        ...obj,
        name: obj.name.toUpperCase(),
      }));

      const result = hooks.reading.fire({ id: 1, name: "alice" });
      expect(result).toEqual({ id: 1, name: "ALICE" });
    });

    it("updating hook receives changes, key, and object", () => {
      const hooks = createTableHooks<User, number>();
      const handler = vi.fn();

      hooks.updating.subscribe(handler);
      hooks.updating.fire({ name: "Bob" }, 1, { id: 1, name: "Alice" });

      expect(handler).toHaveBeenCalledWith({ name: "Bob" }, 1, { id: 1, name: "Alice" });
    });

    it("deleting hook receives key and object", () => {
      const hooks = createTableHooks<User, number>();
      const handler = vi.fn();

      hooks.deleting.subscribe(handler);
      hooks.deleting.fire(1, { id: 1, name: "Alice" });

      expect(handler).toHaveBeenCalledWith(1, { id: 1, name: "Alice" });
    });
  });

  describe("DatabaseChange type", () => {
    it("supports add changes", () => {
      const change: DatabaseChange = {
        table: "users",
        type: "add",
        key: 1,
        obj: { id: 1, name: "Alice" },
      };

      expect(change.type).toBe("add");
      expect(change.obj).toBeDefined();
    });

    it("supports put changes with old value", () => {
      const change: DatabaseChange = {
        table: "users",
        type: "put",
        key: 1,
        obj: { id: 1, name: "Bob" },
        oldObj: { id: 1, name: "Alice" },
      };

      expect(change.type).toBe("put");
      expect(change.oldObj).toBeDefined();
    });

    it("supports delete changes", () => {
      const change: DatabaseChange = {
        table: "users",
        type: "delete",
        key: 1,
        oldObj: { id: 1, name: "Alice" },
      };

      expect(change.type).toBe("delete");
      expect(change.obj).toBeUndefined();
    });
  });
});
