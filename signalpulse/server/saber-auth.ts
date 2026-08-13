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
const EXEMPT_PATHS = new Set(["/api/auth/verify", "/api/health"]);

function isExempt(req: Request): boolean {
  if (EXEMPT_PATHS.has(req.path)) return true;
  // Static assets, HMR, the SPA HTML shell — not our concern.
  if (!req.path.startsWith("/api/")) return true;
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
