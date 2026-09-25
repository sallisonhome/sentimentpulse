export type RatingStatus = "ready" | "stale" | "loading" | "unavailable" | "not_found"
  | "unconfigured" | "ambiguous" | "budget_exhausted" | "rate_limited" | "error" | "unsupported";

export interface PlayerRating {
  source: "steam" | "ps5" | "xbox";
  label: string;
  value: number | null;
  scale: 100 | 5;
  description: string | null;
  count: number | null;
  /** Steam summary cohort; optional for compatibility with older cached responses. */
  reviewScope?: "steam_purchases" | "all";
  url: string | null;
  capturedAt: string | null;
  status: RatingStatus;
}

export interface CriticRating {
  status: RatingStatus;
  provider: "omkarcloud";
  id: number | null;
  name: string | null;
  url: string | null;
  criticsRecommend: number | null;
  topCriticScore: number | null;
  rating: string | null;
  reviewCount: number | null;
  capturedAt: string | null;
}

export interface ReviewsRatings {
  title: string | null;
  players: PlayerRating[];
  openCritic: CriticRating;
  refreshing: boolean;
}
