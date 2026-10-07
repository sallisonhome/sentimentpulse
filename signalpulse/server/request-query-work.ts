import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Common-subexpression reuse inside ONE request, never a response cache.
 * Each request owns its map; no TTL, stale result, process-global board data,
 * or reuse across requests. Failed reads are not recorded.
 */
export function requestQueryWork() {
  const scope = new AsyncLocalStorage<Map<string, unknown>>();
  return {
    run<T>(work: () => T): T { return scope.run(new Map(), work); },
    read<T>(key: string, read: () => T): T {
      const values = scope.getStore();
      if (!values) return read();
      if (!values.has(key)) values.set(key, read());
      return values.get(key) as T;
    },
  };
}
