// Thin client around /gtm/api/* endpoints.
// In dev, Vite proxies /gtm/api/* to the live droplet; in prod, Nginx does it.

export const API_BASE = "/gtm/api";

// ApiError preserves the HTTP status code and (when present) the parsed
// JSON `detail` body, so callers like Library.tsx's "Translate → RU" button
// can distinguish a 409 (translation already exists -- link to it) from any
// other failure (show a generic error toast). Falls back to a stripped-HTML
// string message when the body isn't JSON.
export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    // Backend may not be reachable in some environments. Keep the error
    // message short and human — strip any HTML the upstream returned.
    let detail: unknown = undefined;
    let message = "";
    try {
      const raw = await res.text();
      try {
        const parsed = JSON.parse(raw);
        detail = parsed.detail ?? parsed;
        message =
          typeof detail === "string"
            ? detail
            : (detail as any)?.message || JSON.stringify(detail);
      } catch {
        message = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      }
    } catch {}
    const label = res.status === 404 ? "Not available" : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message ? `${label} — ${message}` : label, detail);
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
  // Genre-benchmark defaults for Step 5 (Median Commercial Potential).
  // Response is already unit-converted server-side: median_revenue_usd_millions
  // (millions of dollars) and avg_price_usd (plain dollars) -- do not scale
  // these further in the UI, just populate the form fields directly.
  genrePulseComps: (genre: string) =>
    request<import("./types").GenrePulseComps>(
      `/defaults/genre_pulse_comps?genre=${encodeURIComponent(genre)}`
    ),
  // Canonical genre list for the Step 2 wizard dropdown. Sorted alphabetically
  // by display name server-side. Users can also enter a free-text genre if
  // theirs isn't in the list -- see the 'Custom' option in Step 2.
  genreList: () =>
    request<import("./types").GenreListEntry[]>("/defaults/genre_list"),
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
  // Phase 4: translate an EN library deck to Russian. Throws ApiError with
  // status 409 and detail={message, existing_deck_id} if a translation
  // already exists; status 502 if Sonar is unavailable or translation fails;
  // status 404 if the source deck doesn't exist.
  translate: (deckId: string, targetLang: import("./types").Language = "ru") =>
    request<import("./types").TranslateResponse>(
      `/library/${deckId}/translate`,
      {
        method: "POST",
        body: JSON.stringify({ target_lang: targetLang }),
      }
    ),
  example: () =>
    request<{ themes: { dark: string[]; light: string[] } }>(`/example`),
  // The preview PNG paths come back as absolute URLs (likely /gtm/api/preview/.../png/...).
  // If they are relative, prefix with API_BASE.
  resolvePng: (url: string) =>
    url.startsWith("http") || url.startsWith("/") ? url : `${API_BASE}/${url}`,

  // ── Library deck viewer ──
  slidesUrl: (deckId: string): string =>
    `${API_BASE}/library/${deckId}/slides`,
  fetchSlides: (deckId: string) =>
    request<import("./types").SlidesResponse>(`/library/${deckId}/slides`),

  // ── Admin ──
  adminLogin: (password: string) =>
    request<{ ok: boolean }>(`/admin/login`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  adminLogout: () =>
    request<{ ok: boolean }>(`/admin/logout`, { method: "POST" }),
  adminSession: () =>
    request<{ authenticated: boolean }>(`/admin/session`),
  adminLibrary: () =>
    request<{ decks: any[] }>(`/admin/library`),
  adminDelete: (deckId: string) =>
    request<{ ok: boolean }>(`/admin/library/${deckId}`, { method: "DELETE" }),
  adminRestore: (deckId: string) =>
    request<{ ok: boolean }>(`/admin/library/${deckId}/restore`, { method: "POST" }),
  adminPurge: (deckId: string) =>
    request<{ ok: boolean }>(`/admin/library/${deckId}/purge`, { method: "DELETE" }),
  adminAudit: (page = 1) =>
    request<{ total: number; page: number; page_size: number; actions: any[] }>(
      `/admin/audit?page=${page}`
    ),
  adminChangePassword: (newPassword: string) =>
    request<{ ok: boolean }>(`/admin/password`, {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
    }),
};
