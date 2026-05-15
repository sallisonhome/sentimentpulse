// Custom hash-location hook for wouter that strips ?query from the path
// portion before matching. wouter's bundled useHashLocation includes the
// querystring in the route, which prevents /new?step=4 from matching the
// /new route. We keep the query in the URL so deep links and back-buttons
// work — components read query params via window.location.hash directly.
import { useSyncExternalStore, useCallback } from "react";

function getHashPath(): string {
  const h = window.location.hash || "#/";
  const raw = h.startsWith("#") ? h.slice(1) : h;
  const q = raw.indexOf("?");
  return q < 0 ? raw || "/" : raw.slice(0, q) || "/";
}

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useHashLocation(): [string, (to: string, opts?: any) => void] {
  const path = useSyncExternalStore(subscribe, getHashPath, getHashPath);
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    // Preserve existing query when destination has no own query.
    const target = to.startsWith("#") ? to.slice(1) : to;
    const next = target.startsWith("/") ? target : `/${target}`;
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    if (opts?.replace) {
      window.history.replaceState(null, "", url);
      // replaceState doesn't fire hashchange, dispatch manually
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      window.location.hash = next;
    }
  }, []);
  return [path, navigate];
}
