// Thin client around /gtm/api/* endpoints.
// In dev, Vite proxies /gtm/api/* to the live droplet; in prod, Nginx does it.

export const API_BASE = "/gtm/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    // Backend may not be reachable in some environments. Keep the error
    // message short and human — strip any HTML the upstream returned.
    let detail = "";
    try {
      const raw = await res.text();
      const stripped = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      detail = stripped.slice(0, 160);
    } catch {}
    const label = res.status === 404 ? "Not available" : `${res.status} ${res.statusText}`;
    throw new Error(detail ? `${label} — ${detail}` : label);
  }
  // Some endpoints stream files; assume JSON otherwise.
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  // @ts-expect-error allow non-JSON
  return res;
}

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  roadmapPhases: () => request<any>("/defaults/roadmap_phases"),
  library: (params: Record<string, string | number | undefined> = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "" && v !== null) q.set(k, String(v));
    }
    const qs = q.toString();
    return request<import("./types").LibraryResponse>(
      `/library${qs ? `?${qs}` : ""}`
    );
  },
  libraryItem: (id: string) =>
    request<import("./types").DeckSummary>(`/library/${id}`),
  downloadUrl: (id: string, format: "pptx" | "pdf") =>
    `${API_BASE}/library/${id}/download?format=${format}`,
  clone: (id: string) =>
    request<{ theme: import("./types").Theme; inputs: any }>(
      `/library/${id}/clone`
    ),
  preview: (body: {
    inputs: import("./types").FormInputs;
    theme: import("./types").Theme;
  }) =>
    request<import("./types").PreviewResponse>(`/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  regenerate: (
    sessionId: string,
    body: {
      inputs: import("./types").FormInputs;
      theme: import("./types").Theme;
    }
  ) =>
    request<import("./types").PreviewResponse>(
      `/preview/${sessionId}/regenerate`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),
  commit: (sessionId: string, isPrivate: boolean) =>
    request<{ deck_id: string }>(`/preview/${sessionId}/commit`, {
      method: "POST",
      body: JSON.stringify({ is_private: isPrivate }),
    }),
  example: () =>
    request<{ pngs: string[]; captions?: string[] }>(`/example`),
  // The preview PNG paths come back as absolute URLs (likely /gtm/api/preview/.../png/...).
  // If they are relative, prefix with API_BASE.
  resolvePng: (url: string) =>
    url.startsWith("http") || url.startsWith("/") ? url : `${API_BASE}/${url}`,
};
