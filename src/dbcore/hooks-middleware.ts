/**
 * Hooks middleware - intercepts DBCore operations to fire table hooks.
 *
 * This middleware provides a consistent interception point for all CRUD operations,
 * ensuring hooks are fired regardless of how operations are performed (Table, Collection, etc.).
 *
 * Hook firing points:
 * - creating: Before add operations
 * - reading: After get/getMany/query operations
 * - updating: Before put operations (when updating existing records)
 * - deleting: Before delete operations
 */

import type {
  DBCore,
  DBCoreTable,
  DBCoreGetRequest,
  DBCoreGetManyRequest,
  DBCoreQueryRequest,
  DBCoreQueryResponse,
  DBCoreMutateRequest,
  DBCoreMutateResponse,
} from "./types.js";
import type { TableHooks } from "../events/index.js";

/**
 * Registry of hooks by table name.
 */
export type HooksRegistry = Map<string, TableHooks<unknown, unknown>>;

/**
 * Create a hooked table wrapper.
 */
function createHookedTable(
  downTable: DBCoreTable,
  getHooks: () => TableHooks<unknown, unknown> | undefined,
): DBCoreTable {
  /**
   * Apply reading hook to a single value.
   */
  function applyReadingHook(value: unknown): unknown {
    if (value === undefined) return value;
    const hooks = getHooks();
    if (!hooks?.reading.hasHandlers()) return value;
    const transformed = hooks.reading.fire(value);
    return transformed !== undefined ? transformed : value;
  }

  /**
   * Apply reading hooks to an array of values.
   */
  function applyReadingHooks(values: unknown[]): unknown[] {
    const hooks = getHooks();
    if (!hooks?.reading.hasHandlers()) return values;

    return values.map((value) => {
      if (value === undefined) return undefined;
      const transformed = hooks.reading.fire(value);
      return transformed !== undefined ? transformed : value;
    });
  }

  return {
    name: downTable.name,
    schema: downTable.schema,

    // Intercept get to apply reading hooks
    async get(req: DBCoreGetRequest): Promise<unknown> {
      const value = await downTable.get(req);
      return applyReadingHook(value);
    },

    // Intercept getMany to apply reading hooks
    async getMany(req: DBCoreGetManyRequest): Promise<unknown[]> {
      const values = await downTable.getMany(req);
      return applyReadingHooks(values);
    },

    // Intercept query to apply reading hooks (when values are returned)
    async query(req: DBCoreQueryRequest): Promise<DBCoreQueryResponse> {
      const response = await downTable.query(req);

      // Only apply reading hooks when returning values (not primary keys)
      // Skip reading hooks if raw mode is requested
      if (req.values !== false && !req.raw) {
        return {
          result: applyReadingHooks(response.result),
        };
      }

      return response;
    },

    // Forward openCursor (hooks not applied to cursors for performance)
    openCursor: downTable.openCursor.bind(downTable),

    // Forward count (no data returned)
    count: downTable.count.bind(downTable),

    // Intercept mutate to fire hooks
    async mutate(req: DBCoreMutateRequest): Promise<DBCoreMutateResponse> {
      const hooks = getHooks();

      switch (req.type) {
        case "add": {
          // Fire creating hooks before add
          if (hooks?.creating.hasHandlers()) {
            const { values, keys } = req;
            for (let i = 0; i < values.length; i++) {
              hooks.creating.fire(keys?.[i], values[i]);
            }
          }
          return downTable.mutate(req);
        }

        case "put": {
          // Note: updating hooks are NOT fired here because we don't have access
          // to the original "changes" object. The middleware only sees the final
          // merged values. Updating hooks are fired at the Table level where
          // the changes object is available (in update(), upsert(), bulkUpdate()).
          return downTable.mutate(req);
        }

        case "delete": {
          // Fire deleting hooks before delete
          if (hooks?.deleting.hasHandlers() && req.keys.length > 0) {
            const existing = await downTable.getMany({
              trans: req.trans,
              keys: req.keys,
            });

            for (let i = 0; i < req.keys.length; i++) {
              const existingValue = existing[i];
              if (existingValue !== undefined) {
                hooks.deleting.fire(req.keys[i], existingValue);
              }
            }
          }
          return downTable.mutate(req);
        }

        case "deleteRange": {
          // Range deletes don't fire individual hooks (matches Dexie behavior)
          return downTable.mutate(req);
        }
      }
    },
  };
}

/**
 * Create the hooks middleware.
 *
 * @param hooksRegistry - Map of table name to hooks
 */
export function createHooksMiddleware(hooksRegistry: HooksRegistry): {
  stack: "dbcore";
  name: string;
  level: number;
  create: (downCore: DBCore) => Partial<DBCore>;
} {
  const tableCache = new Map<string, DBCoreTable>();

  return {
    stack: "dbcore",
    name: "hooks",
    level: 0, // Standard middleware level

    create(downCore: DBCore): Partial<DBCore> {
      return {
        table(name: string): DBCoreTable {
          let hooked = tableCache.get(name);
          if (!hooked) {
            const downTable = downCore.table(name);
            const getHooks = () => hooksRegistry.get(name);
            hooked = createHookedTable(downTable, getHooks);
            tableCache.set(name, hooked);
          }
          return hooked;
        },
      };
    },
  };
}
