#!/usr/bin/env bash
# Invoked ONLY by the manually dispatched encrypted-snapshot workflow.
# No application import, DB writer, service restart or source-tree modification.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "$0")" && pwd)
[[ $# == 1 && "$1" == "$root/snapshot.cms" ]] || exit 2
exec 9>/run/lock/signalpulse-maintenance.lock
flock -n 9 || { echo "Maintenance busy; snapshot not started"; exit 1; }
state=$(systemctl show -p ActiveState --value signalpulse-daily)
case "$state" in
  active|activating|deactivating) echo "Daily job active; snapshot not started"; exit 1;;
esac
wd=$(systemctl show -p WorkingDirectory --value signalpulse)
pid=$(systemctl show -p MainPID --value signalpulse)
[[ "$wd" = /* && -f "$wd/data.db" && "$pid" =~ ^[1-9][0-9]*$ ]] || exit 1
revision=$(git -C "$wd" rev-parse HEAD)
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 1
# Record the deployed driver/runtime build WITHOUT opening source DB. No storage
# import: the only database here is a fresh :memory: handle.
(cd "$wd" && "/proc/$pid/exe" -e '
const D=require("better-sqlite3"), d=new D(":memory:");
console.log(JSON.stringify({node:process.version,
 better_sqlite3:require("better-sqlite3/package.json").version,
 sqlite:d.prepare("select sqlite_version() as v").get().v}));d.close();
') > "$root/runtime.json"
# Lower-priority bounded sequential reads; fail, never retry if resource busy.
TMPDIR="$root" nice -n 15 ionice -c 3 python3 "$root/export-buying-snapshot.py" \
  --db "$wd/data.db" --output "$1" \
  --certificate "$root/buying-snapshot-recipient.crt" \
  --source-revision "$revision" --service-pid "$pid" \
  --runtime-info "$root/runtime.json" \
  --max-seconds 120 --max-bytes 1073741824
[[ "$(systemctl show -p MainPID --value signalpulse)" == "$pid" ]] || {
  echo "Service changed during capture; snapshot rejected"; exit 1;
}
