export type Cohort = { name: string; size: number };
export type USP = { title: string; description: string; proof: string };
export type Reach = {
  cohort: string;
  channel: string;
  message: string;
  kpi: string;
};

export type GameType = "sequel" | "new_ip_with_fans" | "custom";
export type InnerRing = "prev" | "dev" | "other";
export type Theme = "dark" | "light";

export type FormInputs = {
  title: string;
  genre: string;
  game_type: GameType;
  inner: InnerRing;
  release_date: string; // YYYY-MM-DD
  cohorts: Cohort[]; // exactly 4
  usps: USP[]; // 3-5
  reach: Reach[]; // exactly 4
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

export type DeckSummary = {
  id: string;
  title: string;
  genre: string;
  theme: Theme;
  release_date: string;
  created_at: string;
  is_private?: boolean;
  thumb_url?: string;
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
  slide_count: number;
  pngs: string[];
};
