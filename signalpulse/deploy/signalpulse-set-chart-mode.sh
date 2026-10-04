#!/usr/bin/env bash
# signalpulse-set-chart-mode.sh <report|enforce|off>
# Sets CHART_CONSISTENCY_MODE for the signalpulse service through a systemd drop-in and restarts the service.
# The chart-consistency pass runs when a leaderboard request is served, so nothing is rewritten in the database:
# "enforce" changes the numbers and order the API returns for PS5 and Xbox d7/d30; "report" restores annotate-only.
# Reversible by running it again with the other mode. Refuses to run while the daily refresh or another maintenance job
# holds the lock (exit 75). Exit codes: 64 bad mode, 75 lock busy, 1 service did not come back.
set -euo pipefail
MODE="${1:-}"
case "$MODE" in report|enforce|off) ;; *) echo "bad mode (report|enforce|off)" >&2; exit 64;; esac
CONF_DIR="${SP_CONF_DIR:-/etc/systemd/system/signalpulse.service.d}"
log() { echo "$(date -u +%FT%T+00:00) $*"; }
exec 9>"${SP_LOCK_FILE:-/run/lock/signalpulse-maintenance.lock}"
flock -n 9 || { log "daily refresh or maintenance job is running; nothing changed"; exit 75; }
PREV="(none)"; [ -f "$CONF_DIR/chart-mode.conf" ] && PREV=$(grep -o 'CHART_CONSISTENCY_MODE=.*' "$CONF_DIR/chart-mode.conf" || true)
mkdir -p "$CONF_DIR"
printf '[Service]\nEnvironment=CHART_CONSISTENCY_MODE=%s\n' "$MODE" > "$CONF_DIR/chart-mode.conf"
log "previous: $PREV; now: CHART_CONSISTENCY_MODE=$MODE"
systemctl daemon-reload
systemctl restart signalpulse
for _ in $(seq 1 30); do systemctl is-active --quiet signalpulse && break; sleep 1; done
systemctl is-active --quiet signalpulse || { log "service did not come back"; exit 1; }
log "service active; environment: $(systemctl show -p Environment signalpulse | tr ' ' '\n' | grep CHART_CONSISTENCY_MODE || echo 'not visible')"
