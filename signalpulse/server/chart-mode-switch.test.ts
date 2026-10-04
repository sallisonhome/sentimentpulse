import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SP = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(SP, "deploy/signalpulse-set-chart-mode.sh");

test("chart-mode switch: validates the mode, writes the drop-in, restarts, refuses while the lock is held, fails loudly if the service stays down", () => {
  const dir = mkdtempSync(join(tmpdir(), "chart-mode-"));
  try {
    const bin = join(dir, "bin"); mkdirSync(bin);
    const calls = join(dir, "calls.log");
    // systemctl stub: records calls; "is-active" fails when DOWN exists; "show" prints the environment the drop-in would give.
    writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash
echo "systemctl $*" >> "${calls}"
case "$1" in
  is-active) [ -e "${dir}/DOWN" ] && exit 3 || exit 0;;
  show) echo "Environment=CHART_CONSISTENCY_MODE=$(grep -o 'MODE=.*' "${dir}/conf/chart-mode.conf" | cut -d= -f2-)";;
esac
exit 0
`); chmodSync(join(bin, "systemctl"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SP_CONF_DIR: join(dir, "conf"), SP_LOCK_FILE: join(dir, "lock") };
    const run = (...a: string[]) => spawnSync("bash", [SCRIPT, ...a], { encoding: "utf8", env, timeout: 60000 });
    const conf = () => readFileSync(join(dir, "conf/chart-mode.conf"), "utf8");

    assert.equal(run().status, 64, "no mode");
    assert.equal(run("ENFORCE").status, 64, "case-sensitive allow-list");
    assert.equal(run("enforce; rm -rf /").status, 64, "metacharacters rejected");
    assert.equal(existsSync(join(dir, "conf/chart-mode.conf")), false, "nothing written for a bad mode");

    const e = run("enforce"); assert.equal(e.status, 0, e.stdout + e.stderr);
    assert.equal(conf(), "[Service]\nEnvironment=CHART_CONSISTENCY_MODE=enforce\n");
    assert.match(e.stdout, /previous: \(none\); now: CHART_CONSISTENCY_MODE=enforce/);
    assert.match(e.stdout, /environment: Environment=CHART_CONSISTENCY_MODE=enforce/);
    const log = readFileSync(calls, "utf8");
    assert.ok(log.indexOf("daemon-reload") < log.indexOf("restart signalpulse"), "reload before restart");

    const r = run("report"); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /previous: CHART_CONSISTENCY_MODE=enforce; now: CHART_CONSISTENCY_MODE=report/, "rollback path reports what it replaced");
    assert.match(conf(), /=report\n$/);

    // lock held by another process (the daily refresh): nothing changes, exit 75
    const before = conf();
    const busy = spawnSync("bash", ["-c", `exec 8>"${join(dir, "lock")}"; flock -n 8; bash "${SCRIPT}" enforce; echo rc=$?`], { encoding: "utf8", env, timeout: 60000 });
    assert.match(busy.stdout, /rc=75/, busy.stdout + busy.stderr);
    assert.equal(conf(), before, "drop-in untouched while the lock is held");

    writeFileSync(join(dir, "DOWN"), "");
    const down = run("off"); assert.equal(down.status, 1, "service not active after restart fails the run");
    assert.match(down.stdout, /service did not come back/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
