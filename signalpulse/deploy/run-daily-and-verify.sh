#!/usr/bin/env bash
# Transport-independent proof: never accept an earlier successful invocation.
set -Eeuo pipefail
unit=signalpulse-daily.service
before=$(systemctl show -p InvocationID --value "$unit")
state=$(systemctl show -p ActiveState --value "$unit")
case "$state" in
  active|activating|deactivating)
    echo "Refresh already running; refusing duplicate trigger (no stop/restart)."
    exit 75
    ;;
esac
rc=0
systemctl start "$unit" || rc=$?
after=$(systemctl show -p InvocationID --value "$unit")
result=$(systemctl show -p Result --value "$unit")
status=$(systemctl show -p ExecMainStatus --value "$unit")
echo "before=$before after=$after start_exit=$rc Result=$result ExecMainStatus=$status"
[[ "$after" =~ ^[0-9a-f]{32}$ && "$after" != "$before" ]] || {
  echo "FAIL: no new invocation proven"; exit 1;
}
journal=$(journalctl "_SYSTEMD_INVOCATION_ID=$after" --no-pager -o cat)
printf '%s\n' "$journal"
[[ "$rc" = 0 && "$result" = success && "$status" = 0 ]] || exit 1
for phase in 1 2 3 4 5; do
  grep -q "PHASE $phase:" <<<"$journal" || { echo "FAIL: missing phase $phase"; exit 1; }
done
grep -q 'signalpulse-daily done' <<<"$journal" || { echo "FAIL: missing completion marker"; exit 1; }
echo "VERIFIED: new invocation completed all five phases"
