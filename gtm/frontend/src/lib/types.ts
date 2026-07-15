export type Cohort = { name: string; size: number };

// USP: proof/strategy are optional free text; enabled defaults true.
// 1-5 USPs total, but at least 1 must have enabled=true (validated server-side).
export type USP = {
  title: string;
  description: string;
  proof: string;
  strategy?: string;
  enabled?: boolean; // default true
};

export type Reach = {
  cohort: string;
  channel: string;
  message: string;
  kpi: string;
};

// Commercial Risks (Step 6). threat_level is case-insensitive on the
// backend; use lowercase in the UI for consistency with the badge ramp.
export type ThreatLevel = "critical" | "high" | "medium" | "low";
export type CommercialRisk = {
  threat_level: ThreatLevel;
  proof: string;
  mitigation: string;
};

export type GameType = "sequel" | "new_ip_with_fans" | "custom";
export type InnerRing = "prev" | "dev" | "other";
export type Theme = "dark" | "light";

// Platforms supported by the Step 5 Commercial Potential projection table.
export type Platform = "PC" | "PS5" | "XSX" | "SWITCH2";

export type FormInputs = {
  title: string;
  genre: string;
  game_type: GameType;
  inner: InnerRing;
  release_date: string; // YYYY-MM-DD
  cohorts: Cohort[]; // exactly 4

  // --- Step 5: Median Commercial Potential ---
  // NOTE on units (do not conflate these):
  //   median_revenue_usd_millions -- MILLIONS of dollars, e.g. 4.7 means $4,700,000.
  //     Rendered on the slide as the bare number "$4.70" with a small
  //     "in millions" subcopy label -- do NOT multiply/divide this value
  //     anywhere in the frontend; send it exactly as entered.
  //   avg_price_usd -- PLAIN dollars, e.g. 39.99. Never scaled to millions.
  //   median_units_sold -- raw integer unit count, e.g. 1782675. Never scaled to millions.
  //   avg_hours_played -- plain float hours, e.g. 18.7.
  comp_set_name?: string;
  median_revenue_usd_millions: number;
  avg_price_usd: number;
  median_units_sold: number;
  avg_hours_played: number;
  platforms: Platform[]; // 1-4 of PC, PS5, XSX, SWITCH2

  usps: USP[]; // 1-5, at least 1 enabled
  reach: Reach[]; // exactly 4

  // --- Step 6: Commercial Risks ---
  risks: CommercialRisk[]; // 1-5
  risks_wedge?: string;
  risks_wedge_support?: string;

  // --- Step 7: Description & Razors ---
  description_100: string; // ~100 words nominal (soft limit, warn-only)
  razor_20: string; // ~20 words nominal
  razor_10: string; // ~10 words nominal

  inner_definition?: string;
  ring2_definition?: string;
  wedge?: string;
  wedge_support?: string;
  phases_override?: any;
};

export type PreviewResponse = {
  session_id: string;
  theme: Theme;
  pngs: string[];
  slide_count: number;
};

// Phase 4 (Russian localization): every deck row now carries a `language`
// ("en" | "ru", default "en" for all pre-Phase-4 rows) and an optional
// `translated_from_deck_id` linking an RU deck back to its EN source.
// Untranslated EN decks have translated_from_deck_id === null.
export type Language = "en" | "ru";

export type DeckSummary = {
  id: string;
  title: string;
  genre: string;
  theme: Theme;
  release_date: string;
  created_at: string;
  is_private?: boolean;
  thumb_url?: string;
  language: Language;
  translated_from_deck_id: string | null;
};

export type TranslateResponse = {
  deck_id: string;
  language: Language;
  translated_from_deck_id: string;
};

// Shape of the 409 error body returned by POST /library/{id}/translate when
// a translation to that language already exists.
export type TranslateConflictDetail = {
  message: string;
  existing_deck_id: string | null;
};

export type LibraryResponse = {
  total: number;
  page: number;
  page_size: number;
  decks: DeckSummary[];
};

export type RoadmapPhase = {
  id: string;
  name: string;
  window: string;
  bullets: string[];
};

export type SlidesResponse = {
  deck_id: string;
  title: string;
  theme: Theme;
  slide_count: number; // 6 slides per theme (v6.0, locked 2026-07-15)
  pngs: string[];
  // Phase 4: language of THIS deck, plus cross-links in both directions --
  // translated_from_deck_id (RU deck -> its EN source, null for EN decks)
  // and translated_to_deck_id (EN deck -> its RU translation if one exists,
  // always null for RU decks). Both let the Viewer render an EN<->RU chip.
  language: Language;
  translated_from_deck_id: string | null;
  translated_to_deck_id: string | null;
};

// Response shape for GET /defaults/genre_pulse_comps?genre=<slug>
// All currency fields are already converted server-side to the units the
// FormInputs schema expects (millions for revenue, plain dollars for price).
export type GenrePulseComps = {
  median_revenue_usd_millions: number;
  avg_price_usd: number;
  median_units_sold: number;
  avg_hours_played: number;
  comp_set_name: string;
  source: string;
};
