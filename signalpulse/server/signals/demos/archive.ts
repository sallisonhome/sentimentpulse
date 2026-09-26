import { rawSqlite } from "../../storage";
import { loadDemoHistory } from "./history";
import type { CatalogDemo } from "./catalog";
import type { DemoDetail, ArchivedDemoRow } from "../../../shared/demo-detail";

/** Saved values only. No fresh multiplier/CCU floor or parent-game metrics. */
export function archivedSnapshot(title: CatalogDemo): DemoDetail["latest"] & {snapshotAsOf:string|null} {
  const history=loadDemoHistory(rawSqlite,title,"all");
  const last=(key:"lifetimeDownloads"|"totalReviews"|"positivePercent"|"ccuLatest") =>
    [...history.rows].reverse().find(row=>row[key]!==null);
  const downloads=last("lifetimeDownloads"),reviews=last("totalReviews"),sentiment=last("positivePercent"),ccu=last("ccuLatest");
  const evidence=history.rows.filter(row=>row.lifetimeDownloads!==null||row.totalReviews!==null||
    row.reviewsAdded!==null||row.ccuPeak!==null||row.ccuLatest!==null);
  const peaks=history.rows.flatMap(row=>row.ccuPeak===null?[]:[row.ccuPeak]);
  return {
    downloads:downloads?.lifetimeDownloads??null,observedMinimum:false,
    reviews:reviews?.totalReviews??null,positivePercent:sentiment?.positivePercent??null,
    ccu:ccu?.ccuLatest??null,peak:peaks.length?Math.max(...peaks):null,
    ccuObservedAt:ccu?.date??null,actualsAsOf:null,actualsStale:false,actualsRefreshFailed:false,
    snapshotAsOf:evidence.at(-1)?.date??null,
  };
}

export function archivedRow(title:CatalogDemo):ArchivedDemoRow {
  const snapshot=archivedSnapshot(title);
  const actual=title.is_saber_published===1
    ? rawSqlite.prepare(`SELECT downloads,fetched_at FROM demo_download_actuals
        WHERE steam_app_id=? AND window='ltd' AND source='steamworks_downloads_report'`).get(title.steam_app_id) as any
    : null;
  return {appId:title.steam_app_id,name:title.name,genre:title.genre,releaseDate:title.release_date,
    isSaber:title.is_saber_published===1,deactivatedAt:title.deactivated_at??null,
    snapshotAsOf:actual?.fetched_at??snapshot.snapshotAsOf,
    downloads:actual?.downloads??snapshot.downloads,reviews:snapshot.reviews,peak:snapshot.peak};
}
