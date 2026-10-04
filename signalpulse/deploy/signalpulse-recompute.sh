#!/usr/bin/env bash
# signalpulse-recompute.sh — re-derive stored ranks / estimates from data ALREADY collected today.
# No storefront, Steam, Sony or Microsoft requests are made by any action here.
#
# Usage: signalpulse-recompute.sh <action> [overlay] [anchor_mode]
#   ranks-preview     rebuild title-level chart ranks from stored raw chart slots; print the diff; write nothing
#   ranks-apply       same, then write the rebuilt ranks (idempotent)
#   estimate-preview  copy the live DB, run the estimator on the COPY, print the before/after diff and the chart-consistency
#                     report for the live-data copy and for the candidate; live DB untouched.
#                     Optional overlay "key=value,key=value" (numeric values, keys like noise_gate_min_signal.xbox) is
#                     applied to the COPY's app_settings only, to measure a setting before anyone changes production.
#   estimate-apply    run the estimator and the revenue-anchor writer on the live DB (same phases 3 and 4 as the daily job)
#
# Exit codes: 1 no working dir, 2 tsx missing, 3 no raw chart slots yet, 75 lock busy / daily refresh running,
#             76 not enough free disk for a preview copy, 30/40 estimator / anchor phase failed.
set -Eeuo pipefail
ACTION="${1:-}"
OVERLAY="${2:-}"
ANCHOR_MODE="${3:-}"   # estimate-preview only: legacy | report | curve (RANK_ANCHOR_MODE for the copy's estimator run)
if [[ -n "$ANCHOR_MODE" ]]; then
  [[ "$ACTION" == "estimate-preview" ]] || { echo "anchor mode is only allowed for estimate-preview" >&2; exit 64; }
  [[ "$ANCHOR_MODE" =~ ^(legacy|report|curve)$ ]] || { echo "bad anchor mode (legacy|report|curve)" >&2; exit 64; }
fi
case "$ACTION" in ranks-preview|ranks-apply|estimate-preview|estimate-apply) ;; *) echo "unknown action '$ACTION'" >&2; exit 64;; esac
if [[ -n "$OVERLAY" ]]; then
  [[ "$ACTION" == "estimate-preview" ]] || { echo "overlay is only allowed for estimate-preview" >&2; exit 64; }
  [[ "$OVERLAY" =~ ^[A-Za-z0-9_.]+=[0-9]+(\.[0-9]+)?(,[A-Za-z0-9_.]+=[0-9]+(\.[0-9]+)?)*$ ]] || { echo "bad overlay (want key=number[,key=number])" >&2; exit 64; }
fi

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
    (( FREE > SIZE * 3 )) || { log "not enough free disk in /tmp for two copies ($FREE free, db $SIZE)"; exit 76; }
    TMPD="$(mktemp -d /tmp/sp-preview.XXXXXX)"; trap 'rm -rf "$TMPD"' EXIT
    mkdir "$TMPD/base" "$TMPD/cand"
    export TSX_TSCONFIG_PATH="$WD/tsconfig.json"
    log "copying live DB (online backup, live DB is only read)"
    sqlite3 "$WD/data.db" ".backup '$TMPD/base/data.db'"
    cp "$TMPD/base/data.db" "$TMPD/cand/data.db"
    if [[ -n "$OVERLAY" ]]; then
      IFS=',' read -ra KV <<< "$OVERLAY"
      for kv in "${KV[@]}"; do
        k="${kv%%=*}"; v="${kv#*=}"
        sqlite3 "$TMPD/cand/data.db" "INSERT INTO app_settings(key, value, label, category, is_secret, created_at, updated_at) VALUES('$k', '$v', 'preview overlay', 'preview', 0, datetime('now'), datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;"
        log "overlay applied to the COPY only: $k=$v"
      done
    fi
    log "chart report on the live-data copy (before)"
    ( cd "$TMPD/base" && timeout --kill-after=15 240 "$TSX" "$WD/scripts/preview-chart-report.ts" before ) | grep '^CHART' || true
    log "running the estimator on the candidate COPY"
    ( cd "$TMPD/cand" && RANK_ANCHOR_MODE="${ANCHOR_MODE:-legacy}" timeout --kill-after=15 300 "$TSX" "$WD/scripts/estimate-console-units.ts" | tee "$TMPD/cand-estimator.log" ) || { log "estimator failed on the copy"; exit 30; }
    grep '\[rank-anchor-compare\]' "$TMPD/cand-estimator.log" || log "no rank-anchor-compare lines (mode ${ANCHOR_MODE:-legacy})"
    "$TSX" "$WD/scripts/preview-estimate-diff.ts" "$TMPD/base/data.db" "$TMPD/cand/data.db" d7 10
    "$TSX" "$WD/scripts/preview-estimate-diff.ts" "$TMPD/base/data.db" "$TMPD/cand/data.db" d30 10
    log "chart report on the candidate copy (after)"
    ( cd "$TMPD/cand" && timeout --kill-after=15 240 "$TSX" "$WD/scripts/preview-chart-report.ts" after ) | grep '^CHART' || true
    log "preview done; live database unchanged" ;;
  estimate-apply)
    log "PHASE 3: estimate-console-units"; timeout --kill-after=15 300 "$TSX" scripts/estimate-console-units.ts || { log "PHASE 3 failed"; exit 30; }
    log "PHASE 4: write-revenue-anchors"; timeout --kill-after=15 120 "$TSX" scripts/write-revenue-anchors.ts || { log "PHASE 4 failed"; exit 40; }
    log "recompute done" ;;
esac
