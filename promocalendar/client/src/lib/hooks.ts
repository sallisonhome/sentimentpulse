import { useEffect, useState, useCallback } from "react";

/** Poll only while first capture is pending; these reads never call upstream. */
export function usePendingSalesRefresh(pending: boolean | undefined, reload: () => void) {
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [pending, reload]);
}

/**
 * Simple loading hook. `run` fires an async function once on mount and
 * on any dep change. Returns { data, error, loading, reload }.
 * No react-query; the backend is fast and requests are cheap.
 */
export function useAsync<T>(
  run: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: Error | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    run()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/**
 * localStorage-backed persisted string state. Used for per-surface
 * view toggles (grid/timeline, cards/table, list/table).
 * Safe when window/localStorage is missing (SSR-safe).
 */
export function usePersistedState<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const v = window.localStorage.getItem(key);
      return (v as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* quota / private mode */
      }
    },
    [key],
  );
  return [value, set];
}
