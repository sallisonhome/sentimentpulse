import { rawSqlite } from "../../storage";
import { isFriendsPassSku, type SkuKind } from "./friends-pass-identity";

export interface CatalogDemo {
  id: number;
  steam_app_id: string;
  name: string;
  genre: string | null;
  release_date: string | null;
  is_saber_published: number;
  is_active: number;
  availability_source: string | null;
  sku_kind: SkuKind;
  deactivated_at?: string | null;
  tracking_excluded_reason?: string | null;
}

/** Read-only historical access. Never use this roster for collection/ranking. */
export function loadArchivedDemoCatalog(): CatalogDemo[] {
  return (rawSqlite.prepare(`SELECT id,steam_app_id,name,genre,release_date,
    is_saber_published,is_active,availability_source,sku_kind,deactivated_at
    FROM demo_titles WHERE is_active=0 AND sku_kind='demo' AND tracking_excluded_reason IS NULL ORDER BY name`).all() as CatalogDemo[])
    .filter(row => !isFriendsPassSku(row.steam_app_id,row.name));
}

/** Retirement is availability, not tracking eligibility. Invalid identities
 * remain excluded; retired Friends Pass behavior is unchanged. */
export function loadDemoCatalog(kind: SkuKind = "demo"): CatalogDemo[] {
  return (rawSqlite.prepare(`SELECT id,steam_app_id,name,genre,release_date,
    is_saber_published,is_active,availability_source,sku_kind,deactivated_at,tracking_excluded_reason FROM demo_titles
    WHERE tracking_excluded_reason IS NULL AND (is_active=1 OR sku_kind='demo')`).all() as CatalogDemo[])
    .filter(row => row.sku_kind === kind && (kind !== "demo" || !isFriendsPassSku(row.steam_app_id,row.name)))
    .filter(row => kind !== "friends_pass" || row.is_active === 1);
}
