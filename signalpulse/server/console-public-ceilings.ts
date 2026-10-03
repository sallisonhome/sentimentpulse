import { editionGroupKey } from "./console-sales-family";

// Recent first-party (or noted third-party) all-platform lifetime totals.
// A public all-platform total is a ceiling for the tracked platforms (Steam,
// PS5, Xbox); it is not a platform split. `ceilingUnits` is the stated figure
// plus an explicit growth allowance when the statement is more than a few
// months old. Source: signalpulse/docs/public-sales-audit-30-families.md
// (audit of 2026-10-02). Add a family only with a dated, linked source.
// Never add Saber titles or titles with verified anchors: those are protected.
export interface PublicCeiling {
  name: string; aliases?: string[]; ceilingUnits: number; statedUnits: number; asOf: string; source: string; note?: string;
}
export const PUBLIC_LTD_CEILINGS: PublicCeiling[] = [
  { name: "The Witcher 3: Wild Hunt", aliases: ["The Witcher 3: Wild Hunt — Remastered"], statedUnits: 65e6, ceilingUnits: 65e6, asOf: "2026-05-29",
    source: "https://www.kitguru.net/tech-news/mustafa-mahmoud/the-witcher-3-wild-hunt-has-officially-sold-over-65-million-copies/",
    note: "CD Projekt Q1 2026; includes PS4, Xbox One, Switch, GOG and Epic that this board does not track" },
  { name: "Phasmophobia", statedUnits: 27e6, ceilingUnits: 27e6, asOf: "2026-08-05",
    source: "https://www.gamesindustry.biz/phasmophobia-developers-indie-label-kinetic-publishing-", note: "25M+ first-party Jan 2026" },
  { name: "Valheim", statedUnits: 17e6, ceilingUnits: 17e6, asOf: "2026-08-01",
    source: "https://videogamescritic.com/game/valheim-892970" },
  { name: "Black Myth: Wukong", aliases: ["Black Myth: Wukong (Simplified Chinese)"], statedUnits: 30e6, ceilingUnits: 30e6, asOf: "2026-06-17",
    source: "https://www.kitguru.net/gaming/joao-silva/black-myth-wukong-reaches-30-million-sales-miles", note: "third-party (Communist Youth League of China)" },
  { name: "ARC Raiders", statedUnits: 16.3e6, ceilingUnits: 16.3e6, asOf: "2026-08-15",
    source: "https://otakukart.com/arc-raiders-earns-114-9-million-for-nexon-as-sales-reach-16-3-millio", note: "Nexon Q2 2026" },
  { name: "Ready or Not", statedUnits: 13e6, ceilingUnits: 16e6, asOf: "2025-09-09",
    source: "https://www.vgchartz.com/article/465689/ready-or-not-sales-top-13-million-units-inclu", note: "+23% allowance for 13 months of growth" },
  { name: "Crusader Kings III", statedUnits: 4e6, ceilingUnits: 5e6, asOf: "2025-04-23",
    source: "https://www.paradoxinteractive.com/media/press-releases/paradox-interactive/crusader-kings-iii-passes-four-million-sales", note: "+25% allowance for 17 months of growth" },
  { name: "Crimson Desert", statedUnits: 5e6, ceilingUnits: 6.5e6, asOf: "2026-04-15",
    source: "http://www.pearlabyss.com/en-US/Board/Detail?_boardNo=14780", note: "+30% allowance for 5 months of growth" },
];

const BY_KEY = new Map(PUBLIC_LTD_CEILINGS.flatMap(c => [c.name, ...(c.aliases ?? [])].map(n => [editionGroupKey(n), c] as const)));
// Console storefronts append language or edition lists in parentheses, for example
// "Black Myth: Wukong (Simplified Chinese, English, Korean, ...)". Match the exact key
// first, then the key with one trailing parenthetical removed.
export const publicCeilingFor = (key: string | null | undefined) => {
  if (!key) return undefined;
  return BY_KEY.get(key) ?? BY_KEY.get(key.replace(/\s*\([^)]*\)\s*$/, "").trim());
};

// Read-time guard. The Path B overlay shows PS5/Xbox lifetime units as Steam x
// console ratio. When Steam + overlay units for the family exceed the public
// ceiling, the overlay is not used and the native console estimate is kept.
// Lifetime window only. Steam rows are never changed here.
export function overlayExceedsPublicCeiling(a: {
  window: string; familyKey: string | null | undefined; steamUnits: number | null | undefined;
  consoleFactors: number[]; // each console platform's ratio vs Steam (equal-ASP approximation)
}): { exceeds: boolean; ceiling?: PublicCeiling; trackedUnits?: number } {
  if (a.window !== "ltd") return { exceeds: false };
  const ceiling = publicCeilingFor(a.familyKey);
  if (!ceiling || !(a.steamUnits! > 0)) return { exceeds: false };
  const trackedUnits = a.steamUnits! * (1 + a.consoleFactors.reduce((s, f) => s + f, 0));
  return { exceeds: trackedUnits > ceiling.ceilingUnits, ceiling, trackedUnits };
}

// Steam-side cap. A public all-platform total is a hard upper bound for Steam
// alone, so a Steam lifetime estimate above it is scaled down to the bound
// (revenue is scaled; units are revenue-derived at read time). Lifetime window
// only. Verified anchors and public-unit milestones win earlier and never reach
// this. Returns the scale ratio (<1) to apply to revenue, or null.
export function steamPublicCapRatio(a: {
  window: string; familyKey: string | null | undefined; steamUnits: number | null | undefined;
  // Native console units already counted for the same family, including regional or
  // edition listings that carry a different name (matched through ceiling aliases).
  consoleNativeUnits?: number;
}): { ratio: number; ceiling: PublicCeiling; capUnits: number } | null {
  if (a.window !== "ltd") return null;
  const ceiling = publicCeilingFor(a.familyKey);
  if (!ceiling || !(a.steamUnits! > 0)) return null;
  // Steam plus console cannot exceed the all-platform total. Floor the cap at half
  // the total so a bad console estimate cannot collapse Steam.
  const capUnits = Math.max(ceiling.ceilingUnits * STEAM_CAP_FLOOR_SHARE,
    ceiling.ceilingUnits - Math.max(0, a.consoleNativeUnits ?? 0));
  if (a.steamUnits! <= capUnits) return null;
  return { ratio: capUnits / a.steamUnits!, ceiling, capUnits };
}
export const STEAM_CAP_FLOOR_SHARE = 0.5;
