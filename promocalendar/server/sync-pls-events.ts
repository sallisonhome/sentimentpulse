// Cross-app: sync Steam promo campaigns → SignalPulse PLS milestones.
//
// Called at the end of every `/api/:cal/upload` handler once the active
// upload has been swapped in. Groups the current calendar's Steam
// campaigns by game_code → Steam AppID, then POSTs one call per AppID to
// SignalPulse's `/api/promo-support/sync-steam-pls-events` endpoint
// (ops-token-gated).
//
// Non-negotiables:
//   - Must never fail the upload. Every network/JSON/HTTP error is
//     collected into `warnings` and returned; the caller still emits a
//     201 with the warnings surfaced in the response body.
//   - Steam-only. Xbox/PS/Nintendo campaigns are ignored until the
//     matching sales APIs land in SignalPulse.
//   - Idempotent by construction (name format encodes program+start+end
//     and matches server-side `buildPromoName`).
//   - `PROMO_PLS_MIN_DATE` env override (default 2022-01-01) filters out
//     ancient promos that never had SignalPulse revenue data anyway.

import { listCampaigns } from "./storage.js";
import { type CalendarId } from "../shared/schema.js";
import { steamAppIdForCode } from "./signalpulse-map.js";

// SignalPulse and Promo Calendar are co-located on the droplet; loopback
// bypasses the nginx auth wall. In local dev the SignalPulse service may
// not be up — that's fine, the sync errors are captured as warnings.
const SIGNALPULSE_BASE_URL =
  process.env.SIGNALPULSE_BASE_URL || "http://127.0.0.1:5000";

const FETCH_TIMEOUT_MS = 10_000; // 343-row insert per AppID → be generous
const MIN_START_DATE_DEFAULT = "2022-01-01";

export interface PlsSyncCounts {
  created: number;
  updated: number;
  soft_deleted: number;
  un_soft_deleted: number;
  skipped_no_map: number; // campaign game_code not in AppID map
  skipped_no_product: number; // AppID has no matching SignalPulse product
  posted_appids: number; // AppID batches actually sent to SignalPulse
  warnings: string[];
}

/**
 * Run one full sync cycle for a calendar. Reads every Steam campaign in
 * the current active upload from storage.listCampaigns() (no upload_id
 * filter needed — activation happens before sync fires), groups by
 * game_code, calls SignalPulse per AppID, aggregates counts.
 *
 * Never throws. Errors → warnings.
 */
export async function syncSteamPlsEvents(
  cal: CalendarId,
  opts: { minStartDate?: string } = {},
): Promise<PlsSyncCounts> {
  const counts: PlsSyncCounts = {
    created: 0,
    updated: 0,
    soft_deleted: 0,
    un_soft_deleted: 0,
    skipped_no_map: 0,
    skipped_no_product: 0,
    posted_appids: 0,
    warnings: [],
  };

  const opsToken = process.env.INGESTION_OPS_TOKEN;
  if (!opsToken) {
    counts.warnings.push(
      "PLS sync skipped: INGESTION_OPS_TOKEN is not set. Set it in /etc/promocalendar/env (same token SignalPulse uses).",
    );
    return counts;
  }

  const minStartDate = opts.minStartDate || process.env.PROMO_PLS_MIN_DATE || MIN_START_DATE_DEFAULT;

  const allSteam = listCampaigns(cal, { platform: "Steam" });
  // Client-side cutoff — the storage helper accepts `from` but its
  // semantics are for the day-window/gantt query, not the promo-schedule
  // scope. Filter here explicitly.
  const eligible = allSteam.filter((c) => c.start_date >= minStartDate);

  if (eligible.length === 0) {
    counts.warnings.push(
      `No Steam campaigns with start_date >= ${minStartDate} in the current active upload — nothing to sync.`,
    );
    return counts;
  }

  // Group by game_code → events[]
  const byCode = new Map<string, Array<{ program: string; start_date: string; end_date: string }>>();
  for (const c of eligible) {
    if (!byCode.has(c.game_code)) byCode.set(c.game_code, []);
    byCode.get(c.game_code)!.push({
      program: c.program,
      start_date: c.start_date,
      end_date: c.end_date,
    });
  }

  // POST one call per AppID. Sequential (not parallel) so a single slow
  // SignalPulse response doesn't fan out into concurrent DB writes on
  // the SignalPulse side.
  for (const [gameCode, events] of byCode.entries()) {
    const appid = steamAppIdForCode(gameCode);
    if (!appid) {
      counts.skipped_no_map++;
      counts.warnings.push(
        `game_code '${gameCode}' has no Steam AppID mapping — skipped ${events.length} campaigns. Add to promocalendar/server/signalpulse-map.ts to enable sync.`,
      );
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `${SIGNALPULSE_BASE_URL}/api/promo-support/sync-steam-pls-events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ops-token": opsToken,
          },
          body: JSON.stringify({ steam_app_id: appid, events }),
          signal: controller.signal,
        },
      );
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => "<unreadable>");
        counts.warnings.push(
          `SignalPulse sync for ${gameCode} (appid=${appid}) returned HTTP ${resp.status}: ${bodyText.slice(0, 200)}`,
        );
        continue;
      }
      const body = (await resp.json()) as {
        created: number;
        updated: number;
        soft_deleted: number;
        un_soft_deleted: number;
        skipped: string | null;
      };
      counts.posted_appids++;
      if (body.skipped === "no_product") {
        counts.skipped_no_product++;
        counts.warnings.push(
          `${gameCode} (appid=${appid}): no matching product in SignalPulse — ${events.length} campaigns not synced.`,
        );
        continue;
      }
      counts.created += body.created || 0;
      counts.updated += body.updated || 0;
      counts.soft_deleted += body.soft_deleted || 0;
      counts.un_soft_deleted += body.un_soft_deleted || 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      counts.warnings.push(
        `SignalPulse sync for ${gameCode} (appid=${appid}) failed: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return counts;
}
