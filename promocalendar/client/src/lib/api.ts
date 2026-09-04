/**
 * Thin API client for the promo calendar backend. Same-origin by default
 * (Vite/Express serve `/api/*` on the same port). Cross-origin previews
 * can override via `VITE_API_BASE`, e.g. a `__PORT_5003__` placeholder
 * that `deploy_website` rewrites to a proxied URL.
 *
 * Per the 2026-09-04 scope change, we no longer expose a calendar
 * switcher; every call hardcodes `saber`. The backend still accepts
 * `saber_focus` but this UI never sends it.
 */

export const CALENDAR = "saber" as const;

/**
 * Absolute base for API calls. Order of precedence:
 *
 *   1. `VITE_API_BASE` build-time env var (used by preview deploys that
 *      need to point the SPA at a different origin, e.g. a
 *      `__PORT_5003__` placeholder that `deploy_website` rewrites).
 *   2. Runtime inference from `window.location.pathname`: on the droplet
 *      the SPA is served at `/promo/`, so `/api/foo` needs to be
 *      rewritten to `/promo/api/foo` to reach the backend through nginx.
 *      In local dev on `http://localhost:5003/` the pathname is `/`, so
 *      no prefix is added.
 *   3. Empty string = same-origin `/api/*` (fallback).
 */
function inferApiBase(): string {
  const envBase = (import.meta as any).env?.VITE_API_BASE;
  if (envBase) return envBase;
  if (typeof window === "undefined") return "";
  const pathname = window.location.pathname || "";
  // Match a leading /<mount>/ prefix (currently only /promo/ on prod).
  const m = pathname.match(/^\/(promo)(?:\/|$)/);
  return m ? `/${m[1]}` : "";
}

const API_BASE: string = inferApiBase();
function u(path: string): string {
  return `${API_BASE}${path}`;
}

export interface MeResponse {
  email: string | null;
  can_upload: boolean;
}

export interface UploadInfo {
  id: number;
  calendar: string;
  filename: string;
  file_size_bytes: number;
  file_sha256: string;
  uploaded_at: string;
  uploaded_by: string | null;
  events_count: number;
  campaigns_count: number;
  parse_warnings: string[];
  is_active: boolean;
  notes: string | null;
}

export interface CalendarSummary {
  id: string;
  label: string;
  active_upload: UploadInfo | null;
}

export interface Beat {
  campaign_id: number;
  game_code: string;
  game_label: string;
  platform: string;
  program: string;
  start_date: string;
  end_date: string;
  max_discount_pct: number;
  days_until_start: number;
  is_active: boolean;
}

export interface MultiTitleBeat {
  event_key: string;
  program: string;
  platform: string;
  start_date: string;
  end_date: string;
  title_count: number;
  max_discount_pct: number;
  min_discount_pct: number;
  days_until_start: number;
  is_active: boolean;
  games: Array<{ game_code: string; game_label: string }>;
}

export interface EventSummary {
  event_key: string;
  program: string;
  platform: string;
  start_date: string;
  end_date: string;
  title_count: number;
  max_discount_pct: number;
  min_discount_pct: number;
  days_until_start: number;
  is_active: boolean;
  is_past: boolean;
}

export interface EventDetail extends EventSummary {
  games: Array<{
    game_code: string;
    game_label: string;
    campaign_id: number;
    sku_count: number;
    max_discount_pct: number;
    min_discount_pct: number;
  }>;
}

export interface Campaign {
  id: number;
  calendar: string;
  game_code: string;
  game_label: string;
  sheet_name: string;
  sheet_year: number;
  platform: string;
  platform_raw: string;
  program: string;
  start_date: string;
  end_date: string;
  sku_count: number;
  max_discount_pct: number;
  min_discount_pct: number;
  notes: string | null;
}

export interface Sku {
  id: number;
  content_name: string;
  current_srp_usd: number | null;
  promo_srp_usd: number | null;
  discount_pct: number;
  extra: Record<string, unknown>;
  source_row: number;
}

export interface GameSummary {
  game_code: string;
  game_label: string;
  campaign_count: number;
  platforms: string[];
}

export interface FiltersResponse {
  platforms: string[];
  programs: string[];
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const url = u(path);
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = `${msg} — ${body.error}`;
    } catch {
      /* ignore */
    }
    throw new Error(`API ${url} failed: ${msg}`);
  }
  return res.json() as Promise<T>;
}

function q(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export const api = {
  me: () => j<MeResponse>("/api/me"),

  calendars: () => j<{ calendars: CalendarSummary[] }>("/api/calendars"),

  uploads: () => j<{ calendar: string; uploads: UploadInfo[] }>(`/api/${CALENDAR}/uploads`),

  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return j<{ upload: UploadInfo; warnings: string[] }>(`/api/${CALENDAR}/upload`, {
      method: "POST",
      body: fd,
    });
  },

  rollback: (id: number) =>
    j<{ upload: UploadInfo }>(`/api/uploads/${id}/rollback`, { method: "POST" }),

  downloadUrl: (id: number) => u(`/api/uploads/${id}/download`),

  filters: () => j<FiltersResponse>(`/api/${CALENDAR}/filters`),

  games: () => j<{ games: GameSummary[] }>(`/api/${CALENDAR}/games`),

  campaigns: (opts: {
    platform?: string;
    game_code?: string;
    program?: string;
    from?: string;
    to?: string;
  } = {}) => j<{ campaigns: Campaign[] }>(`/api/${CALENDAR}/campaigns${q(opts)}`),

  campaign: (id: number) => j<{ campaign: Campaign; skus: Sku[] }>(`/api/campaigns/${id}`),

  nextUp: (limit = 3, today?: string) =>
    j<{ beats: Beat[] }>(`/api/${CALENDAR}/next-up${q({ limit, today })}`),

  // All currently-in-flight beats (Steam-biased, soonest-ending first). No
  // limit — the front-page section slices client-side and links to a full
  // list route for the rest.
  liveNow: (today?: string) =>
    j<{ beats: Beat[] }>(`/api/${CALENDAR}/live-now${q({ today })}`),

  nextUpMulti: (limit = 3, today?: string, platform?: string) =>
    j<{ beats: MultiTitleBeat[] }>(
      `/api/${CALENDAR}/next-up/multi-title${q({ limit, today, platform })}`,
    ),

  nextUpPlatform: (platform: string, limit = 3, today?: string) =>
    j<{ beats: Beat[] }>(
      `/api/${CALENDAR}/platforms/${encodeURIComponent(platform)}/next-up${q({ limit, today })}`,
    ),

  nextUpGame: (code: string, limit = 3, today?: string) =>
    j<{ beats: Beat[] }>(
      `/api/${CALENDAR}/games/${encodeURIComponent(code)}/next-up${q({ limit, today })}`,
    ),

  events: (opts: {
    when?: "upcoming" | "live" | "past" | "all";
    platform?: string;
    program?: string;
    min_titles?: number;
    from?: string;
    to?: string;
    today?: string;
  } = {}) => j<{ events: EventSummary[]; count: number; when: string }>(
    `/api/${CALENDAR}/events${q(opts)}`,
  ),

  event: (key: string, today?: string) =>
    j<{ event: EventDetail }>(`/api/${CALENDAR}/events/${encodeURIComponent(key)}${q({ today })}`),
};
