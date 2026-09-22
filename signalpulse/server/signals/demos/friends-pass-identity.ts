/** Includes Friend's, Friends', curly apostrophes, and FriendsPass. */
export function isFriendsPassName(name: string): boolean {
  return /\bfriend(?:['’]s|s['’]?)?\s*pass\b/i.test(name.replace(/&#0?39;|&#x27;|&apos;/gi, "'"));
}

// These clients explicitly offer both limited demo play and owner-hosted co-op.
// Evidence is the client's own Steam description, verified 2026-09-22.
export const HYBRID_PASS_IDS = new Set(["3052150", "1377150", "3664720", "2595010", "2591760"]);
export type SkuKind = "demo" | "friends_pass";
// The store calls this client a Demo, but explicitly says "for Buddy Pass
// Users Only": https://store.steampowered.com/app/1056960/Wolfenstein_Youngblood/
// This seeds discovery only; metadata identity and current install offer
// must still pass verification every day.
export const NAMED_PASS_ALIASES: Record<string, {name:string;parent:number}> = {
  "1106040": {name:"Wolfenstein: Youngblood Demo",parent:1056960},
};
export function isFriendsPassSku(appId: string, name: string): boolean {
  return isFriendsPassName(name) || NAMED_PASS_ALIASES[appId]?.name === name;
}
