/**
 * SignalPulse ← saber-auth client bootstrap (Phase 2 cutover, 2026-08-13).
 *
 * Fetches /api/config to learn the current AUTH_MODE, then fetches
 * /auth/api/me to check for an active session. Redirects to
 * /auth/login.html?return=... only when AUTH_MODE=saber AND no session.
 *
 * In "both" and "legacy" modes we never redirect — the old client-side
 * gate keeps working. We still surface the signed-in user (if any) so
 * the header can show "Signed in as ..." and a "Sign out" button that
 * hits /auth/api/logout.
 */

export type AuthMode = "legacy" | "both" | "saber";

export interface AppConfig {
  authMode: AuthMode;
  authReady: boolean;
  authScope: string;
  loginUrl: string;
  logoutUrl: string;
  meUrl: string;
}

export interface SaberUser {
  userId: string;
  email: string;
  scopes: string[];
  isAdmin: boolean;
}

export interface AuthBootstrap {
  config: AppConfig;
  user: SaberUser | null;
}

const DEFAULT_CONFIG: AppConfig = {
  authMode: "legacy",
  authReady: false,
  authScope: "signalpulse",
  loginUrl: "/auth/login.html",
  logoutUrl: "/auth/api/logout",
  meUrl: "/auth/api/me",
};

async function safeJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { credentials: "include", ...init });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function bootstrapAuth(): Promise<AuthBootstrap> {
  // Relative './api/config' so the /signal/ base path is honored (same rule
  // as the existing PasswordGate).
  const config =
    (await safeJson<AppConfig>("./api/config")) || DEFAULT_CONFIG;

  // /auth/api/me is HOST-ABSOLUTE (saber-auth lives at /auth/*, not
  // /signal/auth/*). Send credentials so the saber_session cookie goes with it.
  const meResponse = await fetch(config.meUrl, {
    credentials: "include",
    headers: { Accept: "application/json" },
  }).catch(() => null);

  let user: SaberUser | null = null;
  if (meResponse && meResponse.ok) {
    const body = (await meResponse.json().catch(() => null)) as {
      user?: SaberUser;
    } | null;
    user = body?.user ?? null;
  }

  if (config.authMode === "saber" && !user) {
    // Enforce: redirect to login. return=/signal/ so we come back here.
    const back = encodeURIComponent(window.location.pathname + window.location.hash);
    window.location.replace(`${config.loginUrl}?return=${back}`);
    // Return a stub — the redirect is about to happen; nothing should render.
    return { config, user: null };
  }

  return { config, user };
}

export async function saberLogout(config: AppConfig): Promise<void> {
  try {
    await fetch(config.logoutUrl, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // best-effort
  }
  // Also clear the legacy sessionStorage flag so the launcher and any other
  // apps re-gate the user next time.
  try {
    sessionStorage.removeItem("sp_authenticated");
    localStorage.removeItem("suite_authenticated");
  } catch {
    // ignore
  }
}
