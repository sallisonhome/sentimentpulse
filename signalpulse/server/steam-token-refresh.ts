// ─── Steam long-lived cookie auto-refresh (v3.20, 2026-08-17) ──────────────
//
// Pure HTTP, no browser/Playwright involved. Uses the long-lived
// `steamRefresh_partner` refresh token (~200-day lifetime) to silently mint
// a fresh `steamLoginSecure` access cookie, exactly mirroring what a
// logged-in browser does automatically in the background.
//
// Verified empirically (2026-08-17) against the real Steam endpoints,
// using Node's own fetch (matching this runtime, not just a Python probe):
//   1. POST https://login.steampowered.com/jwt/ajaxrefresh
//        Cookie: steamRefresh_partner=<token>
//        Body: multipart/form-data { redir: <partner url> }
//      -> { success: true, steamID, nonce, auth, redir }
//   2. POST https://partner.steampowered.com/login/settoken
//        Body: application/x-www-form-urlencoded { steamID, redir, nonce, auth }
//      -> Set-Cookie: steamLoginSecure=<new value>  (~24h lifetime)
//
// Confirmed:
//   - `steamLoginSecure` ALONE (no sessionid) is sufficient to authenticate
//     against the Steamworks partner portal (fetchPortalPage in
//     steamworks-portal.ts) -- verified with a real portal fetch.
//   - Neither response rotates `steamRefresh_partner` -- only `ak_bmsc`
//     (unrelated Akamai bot-detection cookie) and `steamLoginSecure` are
//     set. So the original refresh token never needs to be re-captured;
//     only the access cookie gets replaced each cycle.
//
// Never log the raw refresh token or minted cookie value -- lengths and
// booleans only (per the debug-workflow safety pattern).

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REDIR = "https://partner.steampowered.com/nav_games.php";

export interface RefreshResult {
  ok: boolean;
  cookieValue?: string; // "steamLoginSecure=<value>" -- ready to store as cookieValue
  steamID?: string;
  error?: string;
}

export async function refreshSteamCookie(refreshTokenValue: string): Promise<RefreshResult> {
  if (!refreshTokenValue || refreshTokenValue.length < 20) {
    return { ok: false, error: "no refresh token configured" };
  }

  try {
    const form = new FormData();
    form.set("redir", REDIR);
    const step1 = await fetch("https://login.steampowered.com/jwt/ajaxrefresh", {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Referer: REDIR,
        Origin: "https://partner.steampowered.com",
        Cookie: `steamRefresh_partner=${refreshTokenValue}`,
      },
      body: form,
    });

    if (!step1.ok) {
      return { ok: false, error: `ajaxrefresh HTTP ${step1.status}` };
    }

    let data: any;
    try {
      data = await step1.json();
    } catch {
      return { ok: false, error: "ajaxrefresh: response not JSON (refresh token likely expired)" };
    }

    if (!data?.success) {
      return { ok: false, error: "ajaxrefresh: success=false (refresh token likely expired)" };
    }

    const settokenForm = new URLSearchParams({
      steamID: String(data.steamID ?? ""),
      redir: String(data.redir ?? REDIR),
      nonce: String(data.nonce ?? ""),
      auth: String(data.auth ?? ""),
    });

    const step2 = await fetch("https://partner.steampowered.com/login/settoken", {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Referer: REDIR,
        Origin: "https://partner.steampowered.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: settokenForm.toString(),
    });

    if (!step2.ok) {
      return { ok: false, error: `settoken HTTP ${step2.status}` };
    }

    const setCookies = step2.headers.getSetCookie ? step2.headers.getSetCookie() : [];
    const loginSecureRaw = setCookies.find((c) => c.startsWith("steamLoginSecure="));
    if (!loginSecureRaw) {
      return { ok: false, error: "settoken: no steamLoginSecure cookie in response" };
    }

    return {
      ok: true,
      cookieValue: loginSecureRaw.split(";")[0], // "steamLoginSecure=<value>"
      steamID: data.steamID ? String(data.steamID) : undefined,
    };
  } catch (err: any) {
    return { ok: false, error: `refresh error: ${err?.message ?? String(err)}` };
  }
}

/**
 * Orchestrates one full auto-refresh cycle for the 'default' Steamworks
 * session: reads the stored refresh token, mints a fresh access cookie,
 * persists it on success, and always logs the attempt (success or failure)
 * so the Settings UI / failure-driven alert cron can see real health.
 *
 * Storage param typed loosely to avoid a circular import with storage.ts.
 */
export async function performSteamCookieAutoRefresh(storage: {
  getSteamworksSession(id: string): { refreshTokenValue?: string | null; loggedInAs?: string | null } | undefined;
  upsertSteamworksSession(data: any): any;
  logSteamworksSessionRefreshAttempt(id: string, attemptedAt: string, result: string): void;
}): Promise<RefreshResult> {
  const id = "default";
  const now = new Date().toISOString();
  const session = storage.getSteamworksSession(id);

  if (!session?.refreshTokenValue) {
    storage.logSteamworksSessionRefreshAttempt(id, now, "no_refresh_token_configured");
    return { ok: false, error: "no_refresh_token_configured" };
  }

  const result = await refreshSteamCookie(session.refreshTokenValue);

  if (result.ok && result.cookieValue) {
    storage.upsertSteamworksSession({
      id,
      cookieValue: result.cookieValue,
      loggedInAs: session.loggedInAs ?? null,
      lastVerifiedAt: now,
      lastVerifiedResult: "ok",
      refreshSource: "agent_scheduled",
    });
    storage.logSteamworksSessionRefreshAttempt(id, now, "success");
  } else {
    // Truncate error text -- never include raw secret material (there
    // shouldn't be any in these error strings, but keep it short regardless).
    const truncated = `error: ${(result.error ?? "unknown").slice(0, 200)}`;
    storage.logSteamworksSessionRefreshAttempt(id, now, truncated);
  }

  return result;
}

// ─── In-process ~12h auto-refresh scheduler ──────────────────────────────
//
// Mirrors the setInterval + guard pattern used by startIngestionCron() in
// ingestion.ts, but this one is a fixed-period timer (not a time-of-day
// gate) since the refresh just needs to happen roughly twice a day well
// within the ~24h life of the minted steamLoginSecure access cookie.
//
// Also runs once ~2 minutes after boot: every deploy restarts the service
// (signalpulse-deploy.yml), so this gives a free self-heal in case the
// access cookie happened to be close to expiring right when a deploy landed.

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;

let autoRefreshInterval: ReturnType<typeof setInterval> | null = null;
let bootTimeout: ReturnType<typeof setTimeout> | null = null;

export function startSteamCookieAutoRefreshCron(
  storage: Parameters<typeof performSteamCookieAutoRefresh>[0],
  log: (msg: string, source?: string) => void,
): void {
  if (autoRefreshInterval || bootTimeout) return; // idempotent

  log("Steam cookie auto-refresh scheduler started (~2min after boot, then every 12h)", "steam-refresh");

  bootTimeout = setTimeout(() => {
    bootTimeout = null;
    performSteamCookieAutoRefresh(storage)
      .then((r) => log(`Steam cookie auto-refresh (boot self-heal): ${r.ok ? "success" : `failed -- ${r.error}`}`, "steam-refresh"))
      .catch((err) => log(`Steam cookie auto-refresh (boot self-heal) threw: ${err}`, "steam-refresh"));
  }, BOOT_DELAY_MS);

  autoRefreshInterval = setInterval(() => {
    performSteamCookieAutoRefresh(storage)
      .then((r) => log(`Steam cookie auto-refresh: ${r.ok ? "success" : `failed -- ${r.error}`}`, "steam-refresh"))
      .catch((err) => log(`Steam cookie auto-refresh threw: ${err}`, "steam-refresh"));
  }, TWELVE_HOURS_MS);
}

export function stopSteamCookieAutoRefreshCron(): void {
  if (bootTimeout) {
    clearTimeout(bootTimeout);
    bootTimeout = null;
  }
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}
