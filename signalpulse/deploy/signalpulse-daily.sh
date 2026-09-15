#!/usr/bin/env bash
# signalpulse-daily.sh — daily refresh runner invoked by signalpulse-daily.service.
#
# Runs the four-phase console-leaderboards pipeline against the live droplet
# database (SQLite WAL, concurrent reads from the running signalpulse.service
# are safe — the write set here is disjoint from the request-path writer set).
#
# Design intent:
#   1. Resolve WorkingDirectory dynamically from the signalpulse.service unit
#      so this script does NOT hard-code /opt/sentimentpulse/signalpulse and
#      keeps working across a future deploy-path move.
#   2. All shell quoting lives in a real script file, NOT inside a systemd
#      ExecStart= line — the previous inline form kept tripping systemd's
#      argument parser (INVALIDARGUMENT / exit 2) on unit reload.
#   3. Each phase runs with its own timeout so a stuck upstream (Sony /
#      Microsoft rate-limit stall, Steam API 502 loop, IGDB slow query) can
#      never hang the whole timer past the systemd TimeoutStartSec cap.
#   4. Phase failure is loud (non-zero exit, journal shows which phase and
#      what the timeout was) but the timer's next scheduled fire is NOT
#      blocked by a bad run — the [Service] section sets Restart=no.
#   5. LTD_ACCUMULATOR_ENABLED is read from the running signalpulse.service's
#      Environment= so the estimator sees the same feature-flag state the
#      request path sees. A missing flag is treated as unset (safe default:
#      accumulator disabled).
#
# Exit codes:
#   0   — all four phases completed successfully
#   1   — WorkingDirectory could not be resolved
#   2   — tsx binary missing (deploy incomplete)
#   10  — PHASE 1 (verify-discovery) failed
#   20  — PHASE 2 (verify-console-collectors) failed
#   30  — PHASE 3 (estimate-console-units) failed
#   40  — PHASE 4 (write-revenue-anchors) failed
#
# The DIFFERENT exit codes per phase are deliberate — journalctl greps for
# "exited with status=X" and the operator can tell which script broke without
# reading the full pipeline output.

set -Eeuo pipefail

log() {
  printf '%s %s\n' "$(date -Iseconds)" "$*"
}

# --- 1. Resolve WorkingDirectory --------------------------------------------
WD="$(systemctl show -p WorkingDirectory --value signalpulse 2>/dev/null || true)"
if [[ -z "$WD" ]]; then
  log "FATAL: could not resolve WorkingDirectory from signalpulse.service"
  exit 1
fi
cd "$WD"

TSX="$WD/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  log "FATAL: tsx binary missing at $TSX (deploy incomplete?)"
  exit 2
fi

# --- 2. Resolve LTD_ACCUMULATOR_ENABLED from signalpulse.service ------------
# systemctl show emits Environment=A=1 B=2 on one line, space-separated.
# We split on the space, keep only the assignment we want, and default to
# an empty string when missing (estimator treats empty as "disabled").
ENV_LINE="$(systemctl show -p Environment --value signalpulse 2>/dev/null || true)"
LTD_FLAG=""
if [[ -n "$ENV_LINE" ]]; then
  # shellcheck disable=SC2001
  LTD_FLAG="$(echo "$ENV_LINE" | tr ' ' '\n' | sed -n 's/^LTD_ACCUMULATOR_ENABLED=//p' | head -n1)"
fi
export LTD_ACCUMULATOR_ENABLED="${LTD_FLAG:-}"

# --- 3. Run the pipeline ----------------------------------------------------
log "═══ signalpulse-daily start ═══"
log "WD=$WD"
log "LTD_ACCUMULATOR_ENABLED='${LTD_ACCUMULATOR_ENABLED}'"

log "── PHASE 1: verify-discovery ──"
if ! timeout 120 "$TSX" scripts/verify-discovery.ts; then
  log "PHASE 1 failed (timeout=120s)"
  exit 10
fi

log "── PHASE 2: verify-console-collectors ──"
if ! timeout 180 "$TSX" scripts/verify-console-collectors.ts; then
  log "PHASE 2 failed (timeout=180s)"
  exit 20
fi

log "── PHASE 3: estimate-console-units ──"
if ! timeout 300 "$TSX" scripts/estimate-console-units.ts; then
  log "PHASE 3 failed (timeout=300s)"
  exit 30
fi

log "── PHASE 4: write-revenue-anchors ──"
if ! timeout 120 "$TSX" scripts/write-revenue-anchors.ts; then
  log "PHASE 4 failed (timeout=120s)"
  exit 40
fi

log "═══ signalpulse-daily done ═══"
exit 0
