/**
 * Steam Leaderboards — data assembly for the Pre-Release Steam Wishlist
 * Leaderboard (Phase 2). See CLAUDE_STEAM_LEADERBOARDS.md §5/§6.2.
 *
 * Scope matches the ingestion functions in ingestion.ts: pre-release
 * (releaseDate null or in the future) Saber-published titles with a
 * steamAppId. There will never be more than ~20 rows, so all aggregation
 * happens in JS against already-fetched rows — no need for SQL-side
 * pagination or windowing.
 */

import { storage } from "./storage";

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getPreReleaseSaberSteamTitles() {
  const today = getTodayDateString();
  return storage.getAllProducts().filter(
    (p) => p.isSaberPublished && p.steamAppId && (!p.releaseDate || p.releaseDate > today),
  );
}

export interface WishlistLeaderboardRow {
  productId: number;
  title: string;
  steamAppId: string;
  headerImage: string;
  wishlistTotal: number | null;
  wishlistDelta1d: number | null;
  followersTotal: number | null;
  followersDelta1d: number | null;
  rankCurrent: number | null;
  rankDelta7d: number | null;
  igdbHype: number | null;
}

/**
 * headerImage is synthesized from the well-known Cloudflare CDN path
 * rather than fetched via appdetails. Steam has moved some assets to
 * hashed paths, so this can 404 for a subset of unreleased titles — the
 * client handles that with an <img onError> fallback (see leaderboards.tsx)
 * rather than paying the latency of a live appdetails call per row here.
 */
function synthesizeHeaderImage(steamAppId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/header.jpg`;
}

export function getWishlistLeaderboardRows(): WishlistLeaderboardRow[] {
  const titles = getPreReleaseSaberSteamTitles();

  return titles.map((p) => {
    const wishlistSummary = storage.getSteamWishlistSummary(p.id, p.releaseDate ?? null);
    const followersLatest = storage.getLatestSteamFollowers(p.id);
    const rankLatest = storage.getLatestSteamWishlistRank(p.id);
    const rank7dAgo = storage.getSteamWishlistRankDaysAgo(p.id, 7);
    const igdbLatest = storage.getLatestIgdbHype(p.id);

    const rankCurrent = rankLatest?.rank ?? null;
    const rankPast = rank7dAgo?.rank ?? null;
    // Rank is 1-based, lower = better. A positive delta means the title
    // climbed (past rank number was higher/worse than current) — matches
    // the "positive = improvement" convention used for wishlist/follower
    // deltas so the UI can apply a single green-up/red-down rule everywhere.
    const rankDelta7d = rankCurrent != null && rankPast != null ? rankPast - rankCurrent : null;

    return {
      productId: p.id,
      title: p.title,
      steamAppId: p.steamAppId!,
      headerImage: synthesizeHeaderImage(p.steamAppId!),
      wishlistTotal: wishlistSummary.lifetimeNet,
      wishlistDelta1d: wishlistSummary.dayOverDayDelta,
      followersTotal: followersLatest?.followerCount ?? null,
      followersDelta1d: followersLatest?.dailyDelta ?? null,
      rankCurrent,
      rankDelta7d,
      igdbHype: igdbLatest?.hypeScore ?? null,
    };
  });
}

export interface LeaderboardMover {
  productId: number;
  title: string;
  headerImage: string;
  delta: number;
  direction: "up" | "down";
}

function pickBiggestMover(
  rows: WishlistLeaderboardRow[],
  deltaKey: "wishlistDelta1d" | "followersDelta1d" | "rankDelta7d",
): LeaderboardMover | null {
  let best: LeaderboardMover | null = null;
  for (const row of rows) {
    const delta = row[deltaKey];
    if (delta == null || delta === 0) continue;
    if (best == null || Math.abs(delta) > Math.abs(best.delta)) {
      best = {
        productId: row.productId,
        title: row.title,
        headerImage: row.headerImage,
        delta,
        direction: delta > 0 ? "up" : "down",
      };
    }
  }
  return best;
}

export interface WishlistLeaderboardKpis {
  biggest24hWishlistMover: LeaderboardMover | null;
  biggest7dRankMover: LeaderboardMover | null;
  biggest24hFollowerMover: LeaderboardMover | null;
}

export function getWishlistLeaderboardKpis(rows: WishlistLeaderboardRow[]): WishlistLeaderboardKpis {
  return {
    biggest24hWishlistMover: pickBiggestMover(rows, "wishlistDelta1d"),
    biggest7dRankMover: pickBiggestMover(rows, "rankDelta7d"),
    biggest24hFollowerMover: pickBiggestMover(rows, "followersDelta1d"),
  };
}
