// Maps SignalPulse Steam AppIDs → Promo Calendar `game_code`.
//
// The Promo Calendar backend (running on port 5003 in prod, mounted at
// `/promo/api/*` behind nginx) knows Saber titles by short game codes like
// `SM2`, `SNOW`, `ROADCRAFT`. SignalPulse knows the same titles by their
// numeric Steam AppID. This file is the join table.
//
// The Steam AppID is the stable key — add a new row whenever a Saber title
// ships on Steam and gets a Promo Calendar entry. Titles that don't have a
// row here render nothing (no badge), which is the desired behaviour: non-
// Saber and un-mapped titles simply skip the promo lookup.
//
// Non-Saber titles tracked in SignalPulse for competitive reasons (external
// publishers etc.) are deliberately NOT in this map — they wouldn't have
// entries in the Promo Calendar anyway.
export const STEAM_APPID_TO_PROMO_CODE: Record<number, string> = {
  // Warhammer 40,000: Space Marine 2
  2183900: "SM2",
  // SnowRunner
  1465360: "SNOW",
  // Insurgency: Sandstorm
  581320: "ISS",
  // Expeditions: A MudRunner Game
  2477340: "EXPE",
  // RoadCraft
  // RoadCraft (verified 2026-09-04 against Steam store page + SteamDB;
  // earlier value 2698150 was wrong and caused the On Promo badge on the
  // SignalPulse RoadCraft PDP to silently miss its promo lookups).
  2104890: "ROADCRAFT",
  // John Carpenter's Toxic Commando (pre-launch — AppID confirmed on Steam
  // store; update if it changes at launch).
  2157830: "TOXIC COMMANDO",
};

/**
 * Resolve a Steam AppID to a Promo Calendar `game_code`, or `null` if the
 * title isn't in the map. Callers should treat `null` as "no badge".
 */
export function promoCodeForSteamAppId(steamAppId: number | string | null | undefined): string | null {
  if (steamAppId == null) return null;
  const n = typeof steamAppId === "string" ? Number(steamAppId) : steamAppId;
  if (!Number.isFinite(n)) return null;
  return STEAM_APPID_TO_PROMO_CODE[n] ?? null;
}
