/**
 * Reverse of `signalpulse/server/promo-calendar-map.ts`: maps a Promo
 * Calendar `game_code` back to its Steam AppID so this app can query
 * SignalPulse's `/api/promo-support/steam-revenue` endpoint.
 *
 * Keep the two maps in sync. When a new title lands, update BOTH files:
 *   - signalpulse/server/promo-calendar-map.ts   (Steam AppID → game_code)
 *   - promocalendar/server/signalpulse-map.ts    (game_code → Steam AppID)
 */
export const PROMO_CODE_TO_STEAM_APPID: Record<string, number> = {
  // Warhammer 40,000: Space Marine 2
  SM2: 2183900,
  // SnowRunner
  SNOW: 1465360,
  // Insurgency: Sandstorm
  ISS: 581320,
  // Expeditions: A MudRunner Game
  EXPE: 2477340,
  // RoadCraft
  ROADCRAFT: 2698150,
  // John Carpenter's Toxic Commando (verified against Steam store page)
  "TOXIC COMMANDO": 2157830,
};

export function steamAppIdForCode(code: string): number | null {
  return PROMO_CODE_TO_STEAM_APPID[code] ?? null;
}
