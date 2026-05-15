// Parse/stringify form state in the URL hash query so back/forward works
// and reloads don't drop progress. (No localStorage — except for the
// explicit "Save draft" feature.)

export function readUrlParam(name: string): string | null {
  const hash = window.location.hash || "";
  const q = hash.indexOf("?");
  if (q < 0) return null;
  const sp = new URLSearchParams(hash.slice(q + 1));
  return sp.get(name);
}

export function updateUrlParams(updates: Record<string, string | undefined>) {
  const hash = window.location.hash || "#/";
  const q = hash.indexOf("?");
  const path = q < 0 ? hash : hash.slice(0, q);
  const sp = new URLSearchParams(q < 0 ? "" : hash.slice(q + 1));
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  const qs = sp.toString();
  const next = qs ? `${path}?${qs}` : path;
  if (next !== hash) window.history.replaceState(null, "", next);
}
