import { criticSearchTitle, ratingIdentity } from "./reviews-ratings-normalize";

/** Reviewed, exact App-ID aliases for title-wide critic aggregates.
 * These do not rename Steam games, merge player ratings or change sales groups.
 * Steam documents Enhanced/Legacy as GTAV versions:
 * https://store.steampowered.com/app/3240220/
 * https://store.steampowered.com/app/271590/
 * OpenCritic's title-wide record: https://opencritic.com/game/163/grand-theft-auto-v
 * Crimson's existing App ID retains its March 19 release:
 * https://store.steampowered.com/app/3321460/
 * https://opencritic.com/game/19373/crimson-desert
 */
const aliases: Record<string, { names: string[]; name: string; id: number; titleWide?: boolean; releaseDate?: string }> = {
  "3240220": { names: ["Grand Theft Auto V Enhanced"], name: "Grand Theft Auto V", id: 163, titleWide: true },
  "271590": { names: ["Grand Theft Auto V Legacy"], name: "Grand Theft Auto V", id: 163 },
  "3321460": { names: ["Crimson Desert Enhanced"], name: "Crimson Desert", id: 19373 },
  "578080": { names: ["PUBG: BATTLEGROUNDS"], name: "PlayerUnknown's Battlegrounds", id: 4829 },
  // Steam's description still calls the same game Black Desert Online.
  "582660": { names: ["Black Desert", "Black Desert Online"], name: "Black Desert Online", id: 2236, titleWide: true },
  // The Steam page identifies A Realm Reborn as this product's base game.
  "39210": { names: ["FINAL FANTASY XIV Online"], name: "Final Fantasy XIV Online: A Realm Reborn", id: 271 },
  // The current Steam app was Overwatch 2, renamed in February 2026.
  // Never use the separate 2016 Overwatch critic record for this app.
  "2357570": { names: ["Overwatch", "Overwatch 2"], name: "Overwatch 2", id: 13288 },
  // Steam's current page confirms the original September 2, 2014 release.
  "1222670": { names: ["The Sims 4"], name: "The Sims 4", id: 572, releaseDate: "2014-09-02" },
};

export function reviewedCriticAlias(steamAppId: string | null, name: string) {
  const alias = steamAppId ? aliases[steamAppId] : undefined;
  return alias?.names.some(n => ratingIdentity(n) === ratingIdentity(criticSearchTitle(name))) ? alias : null;
}

/** Console observations describe their native listings, not the PC version.
 * Both GTAV PC variants may display the already-verified GTAV console family.
 * The caller must still retain the requested Steam App ID for Steam reviews. */
export function reviewedConsoleSibling(steamAppId: string | null, name: string) {
  return steamAppId === "271590" && reviewedCriticAlias(steamAppId, name) ? "3240220" : null;
}

// Reviewed console versions of the same game. Kept explicit instead of
// globally erasing "Console Edition", "Crimewave" or "Game Preview".
// Native SKU, full-game classification, console compatibility and a current
// native rating must still be checked by the offline backfill generator.
const consoleVersions: Record<string, { steam: string; console: string[] }> = {
  "252490": { steam: "Rust", console: ["Rust Console Edition", "Rust Console Edition X|S"] },
  "2694490": { steam: "Path of Exile 2", console: ["Path of Exile 2 (Game Preview)"] },
  "3551340": { steam: "Football Manager 26", console: ["Football Manager 26 Console"] },
  "322330": { steam: "Don't Starve Together", console: ["Don't Starve Together: Console Edition"] },
  "294100": { steam: "RimWorld", console: ["RimWorld Console Edition"] },
  "218620": { steam: "PAYDAY 2", console: ["PAYDAY 2: CRIMEWAVE EDITION"] },
  "251570": { steam: "7 Days to Die", console: ["7 Days to Die - Console Edition", "7 Days to Die - Console Edition (Game Preview)"] },
  "1962700": { steam: "Subnautica 2", console: ["Subnautica 2 (Game Preview)"] },
  "2252570": { steam: "Football Manager 2024", console: ["Football Manager 2024 Console"] },
  "4465480": { steam: "Counter-Strike:Global Offensive", console: ["Counter-Strike: GO"] },
};
export function reviewedConsoleVersion(appId: string, steamName: string, consoleName: string) {
  const alias = consoleVersions[appId];
  return !!alias && ratingIdentity(steamName) === ratingIdentity(alias.steam)
    && alias.console.some(n => ratingIdentity(n) === ratingIdentity(criticSearchTitle(consoleName)));
}
