// ─── Steamworks raw HTML fetcher (admin diagnostic) ──────────────────
//
// One-off helper used by the /api/steam/raw-fetch admin route to pull
// arbitrary partner.steampowered.com pages (e.g. wishlistdetail,
// navtrafficstats, visibility) using the stored steamLoginSecure cookie.
//
// This module intentionally does NOT parse — the caller gets raw HTML
// and can decide what to extract. Used for spot investigations where
// building a full parser + ingest table would be overkill.
//
// SECURITY NOTES:
//   - The route enforces host allowlisting (partner.steampowered.com and
//     partner.steamgames.com only) so the stored cookie can never be
//     leaked to a third-party host.
//   - Method is GET-only. No form submission, no state-changing calls.
//   - Response bodies can be large; the caller should cap on their end.

export interface RawFetchOptions {
  url: string;
  cookieHeader: string; // raw Cookie header value, e.g. "steamLoginSecure=..."
}

export interface RawFetchResult {
  ok: boolean;
  httpStatus?: number;
  htmlBytes?: number;
  html?: string;
  error?: string;
  finalUrl?: string;
}

const ALLOWED_HOSTS = new Set([
  "partner.steampowered.com",
  "partner.steamgames.com",
]);

export function isAllowedSteamworksUrl(rawUrl: string): { ok: boolean; error?: string; host?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only https:// URLs allowed" };
  }
  if (!ALLOWED_HOSTS.has(parsed.host)) {
    return { ok: false, error: `Host not allowed: ${parsed.host}` };
  }
  return { ok: true, host: parsed.host };
}

export async function fetchSteamworksRawPage(opts: RawFetchOptions): Promise<RawFetchResult> {
  const check = isAllowedSteamworksUrl(opts.url);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  try {
    const resp = await fetch(opts.url, {
      method: "GET",
      headers: {
        Cookie: opts.cookieHeader,
        "User-Agent": "SignalPulse/1.0 (raw-fetch; +https://saber.games)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
    });
    if (resp.status === 301 || resp.status === 302 || resp.status === 303 || resp.status === 307 || resp.status === 308) {
      const loc = resp.headers.get("location") || "";
      return {
        ok: false,
        httpStatus: resp.status,
        error: `Redirected to ${loc.slice(0, 200)} (likely session expired or login required)`,
        finalUrl: loc,
      };
    }
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      return {
        ok: false,
        httpStatus: resp.status,
        error: `HTTP ${resp.status}: ${bodyText.slice(0, 500)}`,
      };
    }
    const html = await resp.text();
    return {
      ok: true,
      httpStatus: resp.status,
      htmlBytes: html.length,
      html,
    };
  } catch (err: any) {
    return { ok: false, error: `fetch error: ${err.message ?? String(err)}` };
  }
}
