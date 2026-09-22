/**
 * Steam Demos leaderboard — Saber Interactive's own demo roster.
 *
 * Hand-verified against api/appdetails on 2026-09-22 (not guessed): each
 * entry's is_active reflects whether appdetails currently resolves it
 * (true) or returns success:false (false, i.e. deactivated post-launch —
 * the same signal signals/demos/runner.ts treats as a deactivation event
 * going forward). genre is Steam's own genre string for the demo.
 *
 * IMPORTANT CORRECTION: Hellraiser Revival's demo was initially treated
 * earlier in this project's research as a third-party calibration anchor.
 * That was wrong — Clive Barker's Hellraiser: Revival is developed AND
 * published by Saber Interactive (confirmed via appdetails developers/
 * publishers fields). It belongs in this Saber roster, not the
 * competitor pool.
 *
 * This is a one-time/rerunnable seed, not a discovery job — Saber's own
 * demos should always be tracked regardless of whether they currently
 * appear on the public Demos hub's "New and Trending" tab (deactivated
 * demos never will). Add new Saber demos here as they ship; the
 * "Add by Steam appid" admin feature (not built yet) will eventually
 * replace hand-maintaining this list.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";

export interface SaberDemoSeed {
  steamAppId: string;
  name: string;
  genre: string;
  isActive: boolean;
}

export const SABER_DEMO_ROSTER: SaberDemoSeed[] = [
  { steamAppId: "5184670", name: "Clive Barker's Hellraiser: Revival Demo", genre: "Action, Adventure", isActive: true },
  { steamAppId: "4010800", name: "Docked Demo", genre: "Simulation", isActive: true },
  { steamAppId: "4354730", name: "John Carpenter's Toxic Commando Demo", genre: "Action", isActive: false },
  { steamAppId: "3462370", name: "The Knightling Demo", genre: "Adventure", isActive: false },
  { steamAppId: "4010830", name: "Bus Bound Demo", genre: "Simulation", isActive: false },
  { steamAppId: "4047990", name: "Painkiller Demo", genre: "Action", isActive: false },
];

const upsertSaberDemoStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_titles
     (steam_app_id, name, base_game_product_id, is_saber_published, genre,
      discovered_via, is_active, first_seen_at, last_checked_at, created_at, updated_at)
   VALUES (?, ?, NULL, 1, ?, 'saber_own', ?, ?, ?, ?, ?)
   ON CONFLICT(steam_app_id) DO UPDATE SET
     name = excluded.name,
     genre = excluded.genre,
     is_saber_published = 1,
     discovered_via = 'saber_own',
     last_checked_at = excluded.last_checked_at,
     updated_at = excluded.updated_at`
);

export function seedSaberDemos(): { seeded: number } {
  const nowIso = new Date().toISOString();
  for (const demo of SABER_DEMO_ROSTER) {
    upsertSaberDemoStmt().run(
      demo.steamAppId, demo.name, demo.genre, demo.isActive ? 1 : 0,
      nowIso, nowIso, nowIso, nowIso,
    );
  }
  log(`saber demo roster seeded: ${SABER_DEMO_ROSTER.length} rows`, "demos-saber-seed");
  return { seeded: SABER_DEMO_ROSTER.length };
}
