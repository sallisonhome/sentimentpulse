# SignalPulse Steam session health check

## Purpose and scope

The read-only workflow `signalpulse-steam-session-health.yml` obtains the two
Steam auto-refresh status fields from the running SignalPulse service. It
uses the repository's existing SSH connection, reads only `INGESTION_OPS_TOKEN`
from `/etc/signalpulse/env`, and issues one GET to
`http://127.0.0.1:5000/api/steam/session` on the droplet.

The ops token never leaves the server. No refresh, browser automation, database
write, deployment, service restart, Nginx change, or certificate change occurs.
The script is streamed over SSH stdin rather than installed on the server.
The workflow has no schedule; the existing Computer automation remains the
only scheduler at 10:46 a.m. America/New_York.

The [live routing audit](https://github.com/sallisonhome/sentimentpulse/actions/runs/36334262917)
found that the suite's IP-address vhost listens only on HTTP; the
[separate-site configuration check](https://github.com/sallisonhome/sentimentpulse/actions/runs/36334262683)
and TLS probe explain the Robo Survivors certificate at that IP.
The server-local check needs no public HTTPS configuration and leaves that
other site's routing untouched.

## Result contract

Download `steam-session-health-RUN_ID` from the exact workflow run and read
`health.json`. It contains `schemaVersion`, `service`, `checkedAt`, and `status`.
A successful check additionally contains only `autoRefreshLastAttemptAt` and
`autoRefreshLastResult`; cookie previews and other session metadata are dropped.
Failure text is sanitized before leaving the server.

| Status | Meaning | Automation action |
|---|---|---|
| `healthy` | Attempt exists; result does not start with lowercase `error` | End silently |
| `no_attempt` | Attempt field missing/null | End silently, per original user rule |
| `refresh_failed` | Attempt exists and result starts with lowercase `error` | Send requested in-app failure notification |
| `check_failed` | Credential, transport, HTTP, or response-validation problem | Report check blocker; do not claim Steam refresh failed |

Workflow success means retrieval succeeded, not necessarily that refresh is
healthy. `refresh_failed` therefore exits zero with the explicit status.
`check_failed` exits nonzero and retains a sanitized diagnostic when available.
A failed SSH setup may leave no artifact; that is a check blocker, never a
healthy result or proof of a Steam refresh failure.

Do not infer failure from age alone. Staleness thresholds are not part of the
user's authorized condition. Do not reuse an old artifact when a new run fails.

## Automation rollout after approval

1. Squash-merge with `[skip ci]` in the merge subject. This ops-only change
   needs no application deployment; the repository's broad push-triggered
   deployment would otherwise restart apps. Do not manually dispatch deployment.
   [GitHub documents skip instructions as applying only to push/pull_request events](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs).
2. Dispatch the new health workflow from `main` once and verify its result.
3. Update the existing Computer automation `d3435608-4827-4594-a7c3-816113a81daa`
   in place to dispatch this workflow through the connected GitHub account.
   Correlate the exact new run by workflow, branch, and dispatch time; validate
   artifact `service`, schema, status, and fresh `checkedAt`.
4. Preserve daily 10:46 Eastern, disabled generic completion notifications,
   silent healthy/no-attempt behavior, and failure-only in-app notification.
5. For `refresh_failed`, title the notification
   `SignalPulse Steam auto-refresh failed`. Include the sanitized result and
   explain that automatic refresh using the stored `steamRefresh_partner`
   failed. If failures persist, the roughly 200-day refresh token may need
   recapture from the user's logged-in Steam tab and resubmission through
   `POST /api/steam/session/capture-refresh-token`. Never do that in this check.

The saved Computer credential can remain stored; this server-local path does
not need to transmit it from Computer. Do not revoke it without user approval.

## QA

Run the self-contained Python tests; no app dependency installation is needed:

```bash
python3 -m unittest discover -s .github/scripts -p test_steam_session_health.py -v
```

Tests cover healthy/missing/failed states, wrong response types, exact GET and
loopback target, time/size bounds, no redirects or proxy inheritance, safe
credential parsing, secret filtering, and safe failures. Pre-merge live QA
uses a temporary branch and the existing dispatchable diagnostic-workflow
filename to run the exact new workflow; that harness is not merged.
