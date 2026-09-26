import type Database from "better-sqlite3";
import type { DemoHistoryPoint, DemoRange } from "../../../shared/demo-detail";
import { NON_SABER_DOWNLOAD_TRIAL } from "./download-consistency";
const DAY = 86400000;
const dayOf = (timestamp: number) => new Date(timestamp).toISOString().slice(0,10);
const millis = (date: string) => Date.parse(`${date}T00:00:00Z`);
type Title = {id:number;steam_app_id:string;is_saber_published:number;is_active:number;deactivated_at?:string|null};

/** No interpolation, zero-filling, weekly-to-daily prorating or parent joins.
 * Activity dates (review buckets) and observation dates have separate columns.
 */
export function loadDemoHistory(db: Database.Database, title: Title, range: DemoRange, today = dayOf(Date.now())) {
  const saber = title.is_saber_published === 1;
  // Availability retirement does not stop observations. Never invent missing days.
  const end = today;
  const points = new Map<string, DemoHistoryPoint>();
  const point = (date: string) => {
    if (!points.has(date)) points.set(date,{date,dailyDownloads:null,lifetimeDownloads:null,downloadObservedAt:null,
      reportEndDate:null,downloadMethod:null,multiplierId:null,reviewsAdded:null,positiveAdded:null,negativeAdded:null,
      reviewBucketObservedAt:null,totalReviews:null,positivePercent:null,reviewObservedAt:null,reviewSource:null,ccuLatest:null,ccuPeak:null,ccuSamples:null});
    return points.get(date)!;
  };
  if (saber) {
    const actuals = db.prepare(`SELECT * FROM demo_download_observations
      WHERE steam_app_id=? AND window='ltd' AND source='steamworks_downloads_report'
      ORDER BY observation_date`).all(title.steam_app_id) as any[];
    let previous: any = null;
    for (const actual of actuals) {
      const p = point(actual.observation_date);
      p.lifetimeDownloads=actual.downloads; p.downloadObservedAt=actual.fetched_at;
      p.reportEndDate=actual.report_end_date; p.downloadMethod=actual.source;
      // Same report window start, adjacent capture dates AND adjacent report
      // end dates. Skipped/repeated report dates are not a one-day change.
      if (previous &&
          millis(actual.observation_date)-millis(previous.observation_date)===DAY &&
          millis(actual.report_end_date)-millis(previous.report_end_date)===DAY &&
          actual.report_start_date===previous.report_start_date) {
        p.dailyDownloads=actual.downloads-previous.downloads; // retain corrections
      }
      previous=actual;
    }
  } else {
    const estimates = db.prepare(`SELECT * FROM demo_window_estimates_daily
      WHERE demo_title_id=? AND window='ltd' AND method='review_delta_multiplier' ORDER BY as_of_date`).all(title.id) as any[];
    for (const e of estimates) {
      const p=point(e.as_of_date);
      // Preserve the model actually recorded at the time, not today's
      // multiplier or a concurrency-derived floor retrofitted into history.
      p.lifetimeDownloads=e.units_mid; p.downloadMethod=e.method; p.multiplierId=e.multiplier_id;
      p.downloadObservedAt=e.as_of_date;
    }
  }
  {
    // The estimator already retained the observed review input each day.
    // Reuse that evidence (including Saber rows) without exposing Saber's
    // legacy modeled download outputs or manufacturing sentiment history.
    const recordedReviews=db.prepare(`SELECT as_of_date,review_count_total FROM demo_window_estimates_daily
      WHERE demo_title_id=? AND window='ltd' AND method='review_delta_multiplier'`).all(title.id) as any[];
    for(const r of recordedReviews) if(Number.isSafeInteger(r.review_count_total)&&r.review_count_total>=0){
      const p=point(r.as_of_date);p.totalReviews=r.review_count_total;
      p.reviewObservedAt=r.as_of_date;p.reviewSource="retained_estimator_review_input";
    }
    const buckets = db.prepare(`SELECT * FROM steam_review_history
      WHERE app_id=? AND bucket_granularity='day' ORDER BY bucket_start`).all(title.steam_app_id) as any[];
    for (const b of buckets) {
      const p=point(dayOf(b.bucket_start*1000));
      p.positiveAdded=b.recommendations_up; p.negativeAdded=b.recommendations_down;
      p.reviewsAdded=b.recommendations_up+b.recommendations_down; p.reviewBucketObservedAt=b.created_at;
      if (!saber) p.dailyDownloads=Math.round(p.reviewsAdded! * NON_SABER_DOWNLOAD_TRIAL);
    }
    const reviews = db.prepare(`SELECT * FROM demo_review_observations WHERE steam_app_id=? ORDER BY observation_date`)
      .all(title.steam_app_id) as any[];
    for (const r of reviews) {
      const p=point(r.observation_date);
      p.totalReviews=r.positive+r.negative; p.positivePercent=p.totalReviews ? r.positive/p.totalReviews*100 : null;
      p.reviewObservedAt=r.fetched_at;
      p.reviewSource=r.source;
    }
    const ccu = db.prepare(`SELECT captured_at,ccu FROM demo_ccu_snapshots WHERE demo_title_id=? ORDER BY captured_at,id`)
      .all(title.id) as Array<{captured_at:string;ccu:number}>;
    for (const r of ccu) {
      const p=point(r.captured_at.slice(0,10));
      p.ccuLatest=r.ccu; p.ccuPeak=Math.max(p.ccuPeak ?? 0,r.ccu); p.ccuSamples=(p.ccuSamples ?? 0)+1;
    }
    // Preserve daily peaks even if raw samples are ever pruned.
    const peaks=db.prepare("SELECT peak_date,peak_ccu FROM demo_ccu_daily_peaks WHERE demo_title_id=?").all(title.id) as any[];
    for(const r of peaks) {
      const p=point(r.peak_date);p.ccuPeak=Math.max(p.ccuPeak??0,r.peak_ccu);
    }
  }
  const dates=Array.from(points.keys()).filter(d=>Number.isFinite(millis(d))&&d<=end&&d>="2000-01-01").sort();
  const firstHistoryDate=dates[0] ?? null;
  const start=range==="all" ? firstHistoryDate ?? end : dayOf(millis(end)-(Number(range)-1)*DAY);
  const rows: DemoHistoryPoint[]=[];
  for(let t=millis(start);t<=millis(end);t+=DAY) rows.push(point(dayOf(t)));
  return {rows,start,end,firstHistoryDate};
}
