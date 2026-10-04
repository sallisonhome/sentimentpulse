#!/usr/bin/env bash
# signalpulse-recompute.sh — re-derive stored ranks / estimates from data ALREADY collected today.
# No storefront, Steam, Sony or Microsoft requests are made by any action here.
#
# Usage: signalpulse-recompute.sh <action>
#   ranks-preview     rebuild title-level chart ranks from stored raw chart slots; print the diff; write nothing
#   ranks-apply       same, then write the rebuilt ranks (idempotent)
#   estimate-preview  copy the live DB, run the estimator on the COPY, print the before/after diff; live DB untouched
#   estimate-apply    run the estimator and the revenue-anchor writer on the live DB (same phases 3 and 4 as the daily job)
#
# Exit codes: 1 no working dir, 2 tsx missing, 3 no raw chart slots yet, 75 lock busy / daily refresh running,
#             76 not enough free disk for a preview copy, 30/40 estimator / anchor phase failed.
set -Eeuo pipefail
ACTION="${1:-}"
case "$ACTION" in ranks-preview|ranks-apply|estimate-preview|estimate-apply) ;; *) echo "unknown action '$ACTION'" >&2; exit 64;; esac

log() { printf '%s %s\n' "$(date -Iseconds)" "$*"; }
WD="$(systemctl show -p WorkingDirectory --value signalpulse 2>/dev/null || true)"
[[ -n "$WD" ]] || { log "FATAL: could not resolve WorkingDirectory"; exit 1; }
cd "$WD"
TSX="$WD/node_modules/.bin/tsx"
[[ -x "$TSX" ]] || { log "FATAL: tsx missing at $TSX"; exit 2; }

# Never overlap the daily refresh (it holds the same lock) and never stop it.
if [[ "$(systemctl show -p ActiveState --value signalpulse-daily.service)" =~ ^(active|activating|deactivating)$ ]]; then
  log "daily refresh is running; refusing to overlap"; exit 75
fi
exec 9>"${SP_LOCK_FILE:-/run/lock/signalpulse-maintenance.lock}"
flock -w 60 9 || { log "maintenance lock busy; nothing started"; exit 75; }

ENV_LINE="$(systemctl show -p Environment --value signalpulse 2>/dev/null || true)"
LTD_FLAG="$(echo "$ENV_LINE" | tr ' ' '\n' | sed -n 's/^LTD_ACCUMULATOR_ENABLED=//p' | head -n1)"
export LTD_ACCUMULATOR_ENABLED="${LTD_FLAG:-}"
export STEAM_CATALOG_COOLDOWN_PATH="${STEAM_CATALOG_COOLDOWN_PATH:-$WD/.steam-catalog-cooldown.sqlite}"

case "$ACTION" in
  ranks-preview) log "ranks preview (no writes)"; timeout --kill-after=15 120 "$TSX" scripts/rebuild-chart-ranks.ts ;;
  ranks-apply)   log "ranks apply"; timeout --kill-after=15 120 "$TSX" scripts/rebuild-chart-ranks.ts --apply ;;
  estimate-preview)
    SIZE=$(stat -c %s "$WD/data.db"); FREE=$(df --output=avail -B1 /tmp | tail -1)
    (( FREE > SIZE * 2 )) || { log "not enough free disk in /tmp for a copy ($FREE free, db $SIZE)"; exit 76; }
    TMPD="$(mktemp -d /tmp/sp-preview.XXXXXX)"; trap 'rm -rf "$TMPD"' EXIT
    log "copying live DB (online backup, live DB is only read)"
    sqlite3 "$WD/data.db" ".backup '$TMPD/data.db'"
    log "running the estimator on the COPY"
    ( cd "$TMPD" && TSX_TSCONFIG_PATH="$WD/tsconfig.json" timeout --kill-after=15 300 "$TSX" "$WD/scripts/estimate-console-units.ts" ) || { log "estimator failed on the copy"; exit 30; }
    "$TSX" "$WD/scripts/preview-estimate-diff.ts" "$WD/data.db" "$TMPD/data.db" d30 15
    "$TSX" "$WD/scripts/preview-estimate-diff.ts" "$WD/data.db" "$TMPD/data.db" d7 10
    log "preview done; live database unchanged" ;;
  estimate-apply)
    log "PHASE 3: estimate-console-units"; timeout --kill-after=15 300 "$TSX" scripts/estimate-console-units.ts || { log "PHASE 3 failed"; exit 30; }
    log "PHASE 4: write-revenue-anchors"; timeout --kill-after=15 120 "$TSX" scripts/write-revenue-anchors.ts || { log "PHASE 4 failed"; exit 40; }
    log "recompute done" ;;
esac
