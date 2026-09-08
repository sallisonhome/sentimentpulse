/**
 * Saber Steam CCU Leaderboard — history + hourly-pattern aggregation
 * (v1.0, 2026-09-08).
 *
 * Ported range semantics from howmanyareplaying/backend/src/routes/history.js
 * exactly:
 *   - range=day   → raw ccu_snapshots_steam rows, trailing 24h
 *   - range=week/month/3m/6m/1y/all → daily_peaks_steam_ccu rows (GREATEST-
 *     wins daily rollup), trailing 7/30/90/180/365 days or unbounded
 * Same "all_time_peak" + "all_time_peak_date" fields alongside the series.
 *
 * Hourly pattern differs from HMAP by timezone only: HMAP buckets by UTC
 * hour (`EXTRACT(HOUR FROM captured_at AT TIME ZONE 'UTC')`); this bucket
 * by America/New_York hour instead, matching SignalPulse's existing
 * ET-anchored ingestion/display convention (see amazon-cron.ts, ingestion.ts
 * '03:00 America/New_York' cron). Same trailing-30-days window, same
 * average-CCU-per-hour-of-day shape.
 */

import { storage } from "./storage";

export type CcuHistoryRange = "day" | "week" | "month" | "3m" | "6m" | "1y" | "all";

const RANGE_DAYS: Record<Exclude<CcuHistoryRange, "day" | "all">, number> = {
  week: 7,
  month: 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dateDaysAgo(days: number): string {
  return isoDaysAgo(days).slice(0, 10);
}

export interface CcuHistoryPoint {
  ccu: number;
  time: string;
}

export interface CcuHistoryResult {
  productId: number;
  range: CcuHistoryRange;
  data: CcuHistoryPoint[];
  allTimePeak: number | null;
  allTimePeakDate: string | null;
}

export function isValidCcuHistoryRange(range: string): range is CcuHistoryRange {
  return ["day", "week", "month", "3m", "6m", "1y", "all"].includes(range);
}

export function getCcuHistory(productId: number, range: CcuHistoryRange): CcuHistoryResult {
  const allTime = storage.getAllTimePeakCcu(productId);

  let data: CcuHistoryPoint[];
  if (range === "day") {
    data = storage.getCcuSnapshotsSince(productId, isoDaysAgo(1)).map((s) => ({ ccu: s.ccu, time: s.capturedAt }));
  } else if (range === "all") {
    data = storage.getDailyPeaksCcuSince(productId, "0000-01-01").map((p) => ({ ccu: p.peakCcu, time: p.peakDate }));
  } else {
    const sinceDate = dateDaysAgo(RANGE_DAYS[range]);
    data = storage.getDailyPeaksCcuSince(productId, sinceDate).map((p) => ({ ccu: p.peakCcu, time: p.peakDate }));
  }

  return {
    productId,
    range,
    data,
    allTimePeak: allTime?.peakCcu ?? null,
    allTimePeakDate: allTime?.peakDate ?? null,
  };
}

export interface CcuHourlyPoint {
  hour: number; // 0-23, America/New_York
  avgCcu: number;
}

export interface CcuHourlyResult {
  productId: number;
  data: CcuHourlyPoint[];
}

/** Hour-of-day (America/New_York) average CCU over the trailing 30 days. */
export function getCcuHourly(productId: number): CcuHourlyResult {
  const snapshots = storage.getCcuSnapshotsSince(productId, isoDaysAgo(30));

  const sums = new Array<number>(24).fill(0);
  const counts = new Array<number>(24).fill(0);
  const hourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });

  for (const s of snapshots) {
    const parts = hourFormatter.formatToParts(new Date(s.capturedAt));
    const hourStr = parts.find((p) => p.type === "hour")?.value ?? "";
    let hour = parseInt(hourStr, 10) % 24; // "24" at midnight w/ hour12:false
    if (!Number.isInteger(hour)) continue;
    sums[hour] += s.ccu;
    counts[hour] += 1;
  }

  const data: CcuHourlyPoint[] = [];
  for (let hour = 0; hour < 24; hour++) {
    if (counts[hour] === 0) continue;
    data.push({ hour, avgCcu: Math.round(sums[hour] / counts[hour]) });
  }

  return { productId, data };
}
