import { rawSqlite } from "../../storage";
import { SABER_DEMO_ROSTER } from "./saber-seed";

export interface CatalogDemo {
  id: number;
  steam_app_id: string;
  name: string;
  genre: string | null;
  release_date: string | null;
  is_saber_published: number;
  is_active: number;
}

/** Deactivated demos are not tracked. Only approved Saber demos retain
 * lifetime actuals. The roster establishes identity, never the Saber flag alone.
 * Callers must restrict inactive rows to the lifetime actuals view.
 */
export function loadDemoCatalog(): CatalogDemo[] {
  const approved = SABER_DEMO_ROSTER.map(demo => demo.steamAppId);
  return rawSqlite.prepare(`SELECT id,steam_app_id,name,genre,release_date,
    is_saber_published,is_active FROM demo_titles
    WHERE is_active=1 OR (is_saber_published=1
      AND steam_app_id IN (${approved.map(() => "?").join(",")}))`).all(...approved) as CatalogDemo[];
}
