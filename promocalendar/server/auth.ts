/**
 * Upload/rollback authorization.
 *
 * The Promo Calendar app trusts the suite-level saber-auth wrapper to prove
 * the caller's identity — nginx forwards the authenticated user's email in
 * the `X-Saber-User` header (also honored: X-Auth-Email, X-Forwarded-Email).
 * This module only decides *which* users are allowed to mutate the calendars.
 *
 * Uploads and rollbacks (mutations) are restricted to this allowlist. Reads
 * are open to any authenticated suite user (enforced by nginx).
 *
 * To change the list, edit ADMIN_UPLOADER_EMAILS below or override at runtime
 * via the PROMO_ADMIN_UPLOADER_EMAILS env var (comma-separated). Env wins.
 */
import type { Request, Response, NextFunction } from "express";

const DEFAULT_ADMIN_UPLOADER_EMAILS: string[] = [
  "allison@saber3d.com",
  "karch@saber3d.com",
  "cmartin@saber3d.com",
  "aiones@saber3d.com",
  "akrupkin@saber3d.com",
];

export function getAdminUploaderEmails(): string[] {
  const override = (process.env.PROMO_ADMIN_UPLOADER_EMAILS || "").trim();
  const list = override
    ? override.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ADMIN_UPLOADER_EMAILS;
  return list.map((e) => e.toLowerCase());
}

/**
 * Extract the caller's email from any of the headers the suite-level
 * saber-auth wrapper is known to set. Case-insensitive. Returns null when
 * no identity header is present.
 */
export function callerEmail(req: Request): string | null {
  const header =
    (req.headers["x-saber-user"] as string | undefined) ??
    (req.headers["x-auth-email"] as string | undefined) ??
    (req.headers["x-forwarded-email"] as string | undefined) ??
    "";
  const email = header.trim().toLowerCase();
  return email || null;
}

/**
 * Middleware. Rejects with 403 unless the caller's identity is in the
 * uploader allowlist. Sets req.callerEmail for downstream handlers to log.
 *
 * Local-dev bypass: set PROMO_SKIP_AUTH=1 to allow every mutation without a
 * suite identity header (matches the Partnerships dev pattern).
 */
export function requireUploader(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (process.env.PROMO_SKIP_AUTH === "1") {
    (req as any).callerEmail = callerEmail(req) ?? "dev@localhost";
    return next();
  }
  const email = callerEmail(req);
  if (!email) {
    res.status(401).json({ error: "no identity header from suite auth" });
    return;
  }
  const allowed = getAdminUploaderEmails();
  if (!allowed.includes(email)) {
    res.status(403).json({
      error: "not authorized to upload or roll back promo calendars",
      caller: email,
    });
    return;
  }
  (req as any).callerEmail = email;
  next();
}

/**
 * For the Settings UI: returns whether the current caller is an uploader.
 * Used by the frontend to hide/show the upload button.
 */
export function isUploaderReq(req: Request): boolean {
  if (process.env.PROMO_SKIP_AUTH === "1") return true;
  const email = callerEmail(req);
  if (!email) return false;
  return getAdminUploaderEmails().includes(email);
}
