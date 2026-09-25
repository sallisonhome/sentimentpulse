// Shared sales-family normalization used by reconciliation and sales routes.
export function editionGroupKey(name: string | null | undefined): string {
  if (!name) return "";
  let s = name.toLowerCase();
  // Strip trademark / registered / smart-quote noise so "PS4™ & PS5™" matches.
  s = s.replace(/[™®℗℠]/g, "");
  s = s.replace(/[‘’‚‛‹›]/g, "'");
  s = s.replace(/[“”„‟«»]/g, '"');
  // Collapse whitespace early so " - " / ": " separators normalize.
  s = s.replace(/\s+/g, " ").trim();
  // Exact reviewed console versions of these title families. This is NOT a
  // generic "remove Console/Remastered/Remake" rule; sequel/year identity stays.
  const consoleFamilies:Record<string,string> = {
    "rimworld console edition":"rimworld",
    "don't starve together: console edition":"don't starve together",
    "football manager 26 console":"football manager 26",
    "football manager 2024 console":"football manager 2024",
    "rust console edition":"rust",
    "rust console edition x|s":"rust",
    "subnautica 2 (game preview)":"subnautica 2",
    "path of exile 2 (game preview)":"path of exile 2",
    "7 days to die - console edition":"7 days to die",
    "7 days to die - console edition (game preview)":"7 days to die",
  };
  s = consoleFamilies[s] ?? s;
  s = s.replace(/\s*[-:]?\s+(?:for\s+)?ps5\s*(?:&|and)\s*ps4\s*$/,"")
    .replace(/\s+for\s+ps[45]\s*$/,"");
  // Sony also uses square-bracket platform tags (Insurgency: Sandstorm).
  // Normalize only explicit platform packaging, never arbitrary subtitles.
  s = s.replace(/\s*\[(ps4\s*(?:&|and)\s*ps5|ps[45])\]\s*$/, " ($1)");

  // Strip trailing parenthesized platform tags — e.g.
  //   "Cyberpunk 2077: Ultimate Edition (Xbox Series X|S)"
  // Store listings on Xbox often append the platform in parens rather than
  // as a colon/dash-separated suffix. Without this the Xbox SKU falls into a
  // different editionGroupKey than its Steam/PS5 twins and drops out of the
  // multiplatform join. Run in a small loop so nested parens like
  //   "Foo (Deluxe) (Xbox Series X|S)" collapse in one pass.
  // Longest / most-specific first — the strip loop breaks on the first hit,
  // so a shorter tag ('xbox series x') must never be tried before a longer
  // superset ('xbox one & xbox series x|s'). Also: never write a literal
  // backslash here — the regex builder handles pipe-escaping.
  const PAREN_PLATFORM_TAGS = [
    "xbox one & xbox series x|s",
    "xbox one and xbox series x|s",
    "ps4 & ps5",
    "ps4 and ps5",
    "playstation 5",
    "playstation 4",
    "xbox series x|s",
    "xbox series x/s",
    "xbox series x",
    "xbox one",
    "ps5",
    "ps4",
    "pc",
    "windows",
    "steam",
  ];
  let parenChanged = true;
  let parenGuard = 0;
  while (parenChanged && parenGuard++ < 4) {
    parenChanged = false;
    for (const tag of PAREN_PLATFORM_TAGS) {
      const tagEsc = tag.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&");
      const re = new RegExp(`\\s*\\(\\s*${tagEsc}\\s*\\)\\s*$`, "i");
      const next = s.replace(re, "");
      if (next !== s && next.length >= 2) {
        s = next.trim();
        parenChanged = true;
        break;
      }
    }
  }

  // Ordered list of edition suffixes. Long/specific first so multi-word suffixes
  // are recognized before their sub-strings. Match at end-of-string only; the
  // pattern anchors at (a) end or (b) end after a colon/dash separator.
  const SUFFIXES: string[] = [
    // Composite / multi-word first
    "digital deluxe edition",
    "premium deluxe edition",
    "legendary edition",
    "definitive edition",
    "anniversary edition",
    "gold edition",
    "deluxe edition",
    "ultimate edition",
    "complete edition",
    "standard edition",
    "premium edition",
    "vault edition",
    "eclipse edition",
    "legacy edition",
    "enhanced edition",
    // Rockstar-style bundle suffixes with in-game currency card DLC
    // (Shark Cards for GTA V, Gold Bars for RDR2, etc). The bundle SKU is
    // still the base game with a DLC add-on — collapse to base for the
    // multiplatform join. Long/specific first so they match before their
    // sub-strings.
    "& great white shark card bundle",
    "& tiger shark cash card bundle",
    "& bull shark cash card bundle",
    "& megalodon shark cash card bundle",
    "& whale shark cash card bundle",
    "& shark cash card bundle",
    "and great white shark card bundle",
    "and shark cash card bundle",
    "kickoff bundle",
    "digital version",
    "friend's pass",
    "friends pass",
    "free trial",
    "game preview",
    // Cross-gen indicators
    "ps4 & ps5",
    "ps4 and ps5",
    "ps5 version",
    "ps4 version",
    "xbox one & xbox series x|s",
    "xbox one and xbox series x|s",
    "xbox series x|s",
    // Bare qualifiers (last so they don't over-match)
    "digital deluxe",
    "premium deluxe",
    "super deluxe",
    "deluxe",
    "ultimate",
    "premium",
    "standard",
    "complete",
    "definitive",
    "gold",
    "vault",
    "eclipse",
    "legacy",
    "enhanced",
  ];

  // Repeatedly strip trailing suffixes so "NBA 2K27: Standard Edition Deluxe"
  // — nonsensical but possible — collapses in one pass.
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (const suf of SUFFIXES) {
      // Strip separator (colon or dash) + optional space + suffix at end.
      const patterns = [
        new RegExp(`[:\\-]\\s*${suf.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&")}\\s*$`),
        new RegExp(`\\s+${suf.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&")}\\s*$`),
        new RegExp(`^${suf.replace(/[|]/g, "\\|").replace(/[.*+?^${}()]/g, "\\$&")}\\s*$`),
      ];
      for (const re of patterns) {
        const next = s.replace(re, "");
        if (next !== s && next.length >= 2) {
          s = next.trim();
          changed = true;
          break;
        }
      }
    }
  }

  // Strip trailing colon / dash / whitespace once suffix removal is done.
  s = s.replace(/[\s:\-]+$/g, "").trim();
  return s;
}
