"""Admin authentication for GTM Slide Pack Studio.

- bcrypt password hash stored in env var GTM_ADMIN_PASSWORD_HASH
- JWT cookie session via python-jose, 30-min sliding expiry
- Rate-limited login (5/15min/IP) handled in main.py via slowapi
"""

from __future__ import annotations

import datetime as dt
import os
import uuid
from pathlib import Path
from typing import Optional

import bcrypt
from dotenv import load_dotenv
from fastapi import Cookie, HTTPException, Request, Response
from jose import JWTError, jwt

ENV_FILE = Path(os.getenv("GTM_ENV_FILE", "/etc/gtm/.env"))
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)

COOKIE_NAME = "gtm_admin"
SESSION_TTL_MINUTES = 30


def _password_hash() -> str:
    h = os.getenv("GTM_ADMIN_PASSWORD_HASH")
    if not h:
        # Default to bcrypt hash of "password" if no hash set.
        # This is the documented dev-mode default. Admins rotate via UI.
        return bcrypt.hashpw(b"password", bcrypt.gensalt()).decode()
    return h


def _jwt_secret() -> str:
    secret = os.getenv("GTM_JWT_SECRET")
    if not secret:
        # Fallback secret — fine for dev. In production set via env.
        secret = "gtm-dev-secret-please-rotate-via-admin-console"
    return secret


def verify_password(plain: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), _password_hash().encode())
    except Exception:
        return False


def make_session_token() -> str:
    now = dt.datetime.utcnow()
    payload = {
        "sub": "gtm-admin",
        "iat": now.timestamp(),
        "exp": (now + dt.timedelta(minutes=SESSION_TTL_MINUTES)).timestamp(),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, _jwt_secret(), algorithm="HS256")


def decode_session(token: str) -> dict:
    return jwt.decode(token, _jwt_secret(), algorithms=["HS256"])


def _cookie_path() -> str:
    """Cookie path — / in tests, /gtm/api/ in production."""
    return os.getenv("GTM_COOKIE_PATH", "/gtm/api/")


def set_session_cookie(response: Response, token: str):
    """HttpOnly cookie. Lax SameSite so it works for normal navigation.
    Secure=False because the suite is HTTP-only right now; flip to True
    once HTTPS is enabled (gated on GTM_HTTPS env var).
    """
    secure = os.getenv("GTM_HTTPS", "false").lower() in ("1", "true", "yes")
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=SESSION_TTL_MINUTES * 60,
        httponly=True,
        secure=secure,
        samesite="lax",
        path=_cookie_path(),
    )


def clear_session_cookie(response: Response):
    response.delete_cookie(COOKIE_NAME, path=_cookie_path())


def require_admin(request: Request) -> dict:
    """FastAPI dependency that raises 401 if no valid admin cookie."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Admin authentication required")
    try:
        return decode_session(token)
    except JWTError:
        raise HTTPException(401, "Invalid or expired admin session")


def set_new_password_hash(plain: str):
    """Write a new bcrypt hash to the env file. Returns the new hash."""
    new_hash = bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()

    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if not line.startswith("GTM_ADMIN_PASSWORD_HASH="):
                lines.append(line)
    lines.append(f"GTM_ADMIN_PASSWORD_HASH={new_hash}")
    ENV_FILE.write_text("\n".join(lines) + "\n")
    ENV_FILE.chmod(0o600)

    # Update in-process env so subsequent requests see it immediately
    os.environ["GTM_ADMIN_PASSWORD_HASH"] = new_hash
    return new_hash
