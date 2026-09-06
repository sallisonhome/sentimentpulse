/**
 * SignalPulse ← saber-auth integration (Phase 2 cutover, 2026-08-13).
 *
 * Wraps the shared drop-in middleware from sallisonhome/saber-auth
 * (integrations/node-express/saber-auth-middleware.js), which lives at
 * ./saber-auth-middleware.cjs in this repo.
 *
 * Three modes (AUTH_MODE env var):
 *   - "legacy" — no saber-auth enforcement; only the existing client-side
 *                gate (unchanged behavior). This is a rollback escape hatch.
 *   - "both"   — DEFAULT for the one-week rollout. Every /api/* request is
 *                inspected for a saber session cookie. If present and valid,
 *                we tag req.saberUser. If missing or invalid, we log the
 *                would-be denial and PASS THE REQUEST (advisory mode).
 *                Zero user impact; produces telemetry so we can see whether
 *                real traffic has valid sessions before flipping to enforce.
 *   - "saber"  — enforce. Missing/invalid session → 401 JSON on API, redirect
 *                to /auth/login.html on HTML.
 *
 * The middleware skips two routes regardless of mode:
 *   POST /api/auth/verify   (legacy password verify; still works so the
 *                            SABER-shared-password fallback isn't broken)
 *   GET  /api/health        (unauthenticated liveness probe)
 */

// Inlined port of sallisonhome/saber-auth's
// integrations/node-express/saber-auth-middleware.js. Kept inline (not
// require()'d) because the esbuild CJS bundle strips import.meta.url,
// which breaks createRequire. Behavior is identical to the upstream file;
// if that file changes, update this port to match.
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const COOKIE_NAME = "saber_session";

interface SaberDecoded {
  sub: string;
  email: string;
  scopes?: string[];
  is_admin?: boolean;
  jti: string;
}

interface SaberUser {
  userId: string;
  email: string;
  scopes: string[];
  isAdmin: boolean;
  jti: string;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return readCookie(req, COOKIE_NAME);
}

function saberAuth(opts: {
  scope: string;
  loginUrl?: string;
  jwtSecret: string;
}): {
  loadUser: (req: Request) => Promise<SaberUser | null>;
} {
  const secret = opts.jwtSecret;
  async function loadUser(req: Request): Promise<SaberUser | null> {
    const token = extractToken(req);
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, secret) as SaberDecoded;
      return {
        userId: decoded.sub,
        email: decoded.email,
        scopes: Array.isArray(decoded.scopes) ? decoded.scopes : [],
        isAdmin: !!decoded.is_admin,
        jti: decoded.jti,
      };
    } catch {
      return null;
    }
  }
  return { loadUser };
}

export type AuthMode = "legacy" | "both" | "saber";

export function readAuthMode(): AuthMode {
  const raw = (process.env.AUTH_MODE || "both").toLowerCase();
  if (raw === "legacy" || raw === "saber" || raw === "both") return raw;
  console.warn(
    `[saber-auth] AUTH_MODE="${raw}" is invalid; falling back to "both".`,
  );
  return "both";
}

// Routes exempt from saber-auth even in "saber" mode.
// /api/config is intentionally public: it's non-sensitive (authMode,
// authReady, login/logout URLs) and the unauthenticated SPA must be able to
// read it to know whether to redirect to /auth/login.html in the first
// place — gating it behind auth created a chicken-and-egg bug (also broke
// the deploy smoke test, which reads authMode/authReady from this route).
const EXEMPT_PATHS = new Set(["/api/auth/verify", "/api/health", "/api/config"]);

// Cross-app READ-ONLY support endpoints called by sibling Saber Suite
// services (currently the Promo Calendar) over loopback. These return
// aggregated Steam metrics or active-promo tuples keyed on Steam AppID
// and never leak PII, so they don't need a human JWT session.
//
// WRITE endpoints under /api/promo-support/ go through OPS_TOKEN_PATHS
// below (must be listed by exact path AND require a valid x-ops-token
// header). Do NOT widen this list to a prefix.
const EXEMPT_PATHS_READ_ONLY_CROSS_APP = new Set([
  // Promo Calendar → Steam revenue for one AppID + window
  "/api/promo-support/steam-revenue",
  // Promo Calendar → same, batched (many AppID+window tuples in one call)
  "/api/promo-support/steam-revenue-batch",
  // Promo Calendar → per-country sales breakdown for one AppID + window
  // (v3.31, 2026-09-05). Same posture: read-only, aggregate country-level
  // totals, no PII, safe to expose unauthenticated over loopback + nginx.
  "/api/promo-support/sales-by-country",
]);
const EXEMPT_PREFIXES = [
  "/api/onpromo/", // SignalPulse's OWN SPA reads this too, but it is
                    // safe to expose unauthenticated: it only returns
                    // {steam_app_id → [{platform, end_date}]} tuples,
                    // no PII.
];

function isExempt(req: Request): boolean {
  if (EXEMPT_PATHS.has(req.path)) return true;
  if (EXEMPT_PATHS_READ_ONLY_CROSS_APP.has(req.path)) return true;
  for (const pfx of EXEMPT_PREFIXES) {
    if (req.path.startsWith(pfx)) return true;
  }
  // Static assets, HMR, the SPA HTML shell — not our concern.
  if (!req.path.startsWith("/api/")) return true;
  return false;
}

// ─── Ops/automation service token (2026-08-20) ──────────────────────────────
// AUTH_MODE=saber enforces human JWT sessions on every /api/* route, which is
// correct for the SPA but breaks unattended automation (GitHub Actions
// workflows, this app's own scheduled ingestion triggers, health-check
// crons) that has no browser session to present. Rather than requiring those
// callers to log in, a narrow set of automation-only routes accept a
// separate service token via the `x-ops-token` header.
//
// This is intentionally NOT a general auth bypass:
//   - Only the specific routes below honor the token; everything else still
//     requires a human JWT exactly as before.
//   - It only activates when INGESTION_OPS_TOKEN is set in the environment;
//     unset (the pre-2026-08-20 default) means these routes behave exactly
//     as they did previously (JWT only).
//   - The token is a fresh, purpose-built shared secret (not derived from
//     the JWT signing secret or any other credential) with no session/user
//     impersonation semantics.
const OPS_TOKEN_PATHS = new Set([
  "/api/ingestion/run",
  "/api/ingestion/run-sales",
  "/api/ingestion/run-public-wishlist",
  "/api/ingestion/run-partner-wishlist",
  "/api/ingestion/run-wishlist-conversion-benchmarks",
  "/api/ingestion/status",
  "/api/ingestion/manual-status",
  "/api/steam/session",
  // Cross-app write from Promo Calendar: sync Steam-promo PLS milestones
  // for one product. See server/promo-support-routes.ts.
  "/api/promo-support/sync-steam-pls-events",
  // v3.30 (2026-09-05): purpose-built ops route for the Sales-by-Country
  // monthly backfill workflow. Body: {product_id, dateStart, dateEnd}.
  // Internally calls the same fetchPortalPage + upserts as the human
  // portal-fetch endpoint, but doesn't require a JWT session. See
  // routes.ts /api/ops/portal-fetch.
  "/api/ops/portal-fetch",
]);

// Path prefixes that accept the ops token. Use for endpoint groups that have
// variable path parameters (:job, :platform, etc.) where a literal Set
// lookup won't match. The Amazon ingest trigger is
// /api/amazon/ingest/run/:job — six distinct paths (charts, products,
// movers, keywords, new_releases, also_bought) that should all accept the
// ops token so scheduled workflows and this app's own cron self-trigger
// endpoints can drive them without a human JWT.
const OPS_TOKEN_PREFIXES = [
  "/api/amazon/ingest/", // covers /run/:job POST and /runs GET summary
];

function hasValidOpsToken(req: Request): boolean {
  const expected = process.env.INGESTION_OPS_TOKEN;
  if (!expected) return false;
  const provided = req.headers["x-ops-token"];
  if (typeof provided !== "string" || provided.length === 0) return false;
  return provided === expected;
}

function isOpsTokenPath(path: string): boolean {
  if (OPS_TOKEN_PATHS.has(path)) return true;
  for (const pfx of OPS_TOKEN_PREFIXES) {
    if (path.startsWith(pfx)) return true;
  }
  return false;
}

interface SaberContext {
  mode: AuthMode;
  ready: boolean;
  scope: string;
}

export function createSaberAuthMiddleware(): {
  context: SaberContext;
  middleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<void> | void;
} {
  const mode = readAuthMode();
  const scope = "signalpulse";
  const secret = process.env.SABER_AUTH_JWT_SECRET;

  const context: SaberContext = { mode, ready: false, scope };

  if (mode === "legacy") {
    console.log(
      "[saber-auth] AUTH_MODE=legacy — saber-auth is disabled. Legacy client-side gate only.",
    );
    return {
      context,
      middleware: (_req, _res, next) => next(),
    };
  }

  if (!secret) {
    // Fail-open in "both", fail-closed in "saber".
    if (mode === "both") {
      console.error(
        "[saber-auth] AUTH_MODE=both but SABER_AUTH_JWT_SECRET is missing. Advisory mode with all requests marked 'skip-no-secret'. Please set the env var.",
      );
      return {
        context,
        middleware: (req, _res, next) => {
          if (!isExempt(req)) {
            console.warn(
              `[saber-auth][advisory] ${req.method} ${req.path} — no JWT secret configured; would fail-closed in saber mode.`,
            );
          }
          next();
        },
      };
    }
    // saber mode without secret is a hard configuration error.
    throw new Error(
      "[saber-auth] AUTH_MODE=saber requires SABER_AUTH_JWT_SECRET env var. Refusing to start.",
    );
  }

  const auth = saberAuth({
    scope,
    loginUrl: "/auth/login.html",
    jwtSecret: secret,
  });
  context.ready = true;
  console.log(
    `[saber-auth] initialized: mode=${mode}, scope=${scope}, loginUrl=/auth/login.html`,
  );

  const middleware = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (isExempt(req)) return next();

    if (isOpsTokenPath(req.path) && hasValidOpsToken(req)) {
      (req as Request & { saberUser?: unknown }).saberUser = {
        userId: "ops-automation",
        email: "ops-automation@internal",
        scopes: [scope],
        isAdmin: false,
        jti: "ops-token",
      };
      return next();
    }

    // Try to load a user without enforcing.
    let user: Awaited<ReturnType<typeof auth.loadUser>> = null;
    try {
      user = await auth.loadUser(req);
    } catch (err) {
      console.error("[saber-auth] loadUser threw:", err);
    }

    if (user) {
      (req as Request & { saberUser?: unknown }).saberUser = user;
    }

    if (mode === "both") {
      if (!user) {
        console.warn(
          `[saber-auth][advisory] ${req.method} ${req.path} — no valid saber session; would 401 in saber mode.`,
        );
      } else if (!user.scopes.includes(scope) && !user.isAdmin) {
        console.warn(
          `[saber-auth][advisory] ${req.method} ${req.path} — user ${user.email} lacks '${scope}' scope; would 403 in saber mode.`,
        );
      }
      return next();
    }

    // mode === "saber": enforce.
    if (!user) {
      const wantsHtml = (req.headers.accept || "").includes("text/html");
      if (wantsHtml) {
        const back = encodeURIComponent(req.originalUrl || req.url);
        res.redirect(302, `/auth/login.html?return=${back}`);
        return;
      }
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (!user.scopes.includes(scope) && !user.isAdmin) {
      res.status(403).json({ error: `Scope '${scope}' required.` });
      return;
    }
    next();
  };

  return { context, middleware };
}
