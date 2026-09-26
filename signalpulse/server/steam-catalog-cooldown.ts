import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

/** Appdetails only: never suppress fresh rating/histogram collection. */
export class SteamCatalogDeferred extends Error {
  constructor(public readonly retryAt: number | null, reason = "cooldown") {
    super(`steam_metadata_deferred:${reason}${retryAt == null ? "" : ` until ${new Date(retryAt).toISOString()}`}`);
  }
}
export interface SteamCatalogCooldown {
  check(): void;
  defer(retryAfter: string | null): number;
}
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value?.trim()) return null;
  const n = Number(value);
  const delay = Number.isFinite(n) ? n * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 && Number.isSafeInteger(Math.ceil(delay)) &&
    Number.isFinite(new Date(now+Math.ceil(delay)).getTime()) ? Math.ceil(delay) : null;
}
/** Separate operational SQLite state, NOT the sales database. Transactions
 * survive process boundaries and release locks after a crash. Concurrent writers
 * cannot shorten a longer Retry-After. Bad/unwritable/busy state fails closed.
 */
export function fileSteamCatalogCooldown(
  path = process.env.STEAM_CATALOG_COOLDOWN_PATH || resolve(".steam-catalog-cooldown.sqlite"),
  now: () => number = Date.now,
): SteamCatalogCooldown {
  const update = (next: (until: number) => number): number => {
    let db:Database.Database|undefined;
    try {
      mkdirSync(dirname(path), { recursive: true });
      db=new Database(path,{timeout:500});
      db.exec("CREATE TABLE IF NOT EXISTS steam_metadata_cooldown_v1(id INTEGER PRIMARY KEY CHECK(id=1),until_ms INTEGER NOT NULL)");
      return db.transaction(()=>{
        const state=db!.prepare("SELECT until_ms FROM steam_metadata_cooldown_v1 WHERE id=1").get() as {until_ms:number}|undefined;
        const previous=state?.until_ms??0;
        if(!Number.isSafeInteger(previous)||previous<0||!Number.isFinite(new Date(previous).getTime()))
          throw new SteamCatalogDeferred(null,"invalid_state");
        const until=next(previous);
        // A writable transaction is required BEFORE HTTP, not just after 429.
        db!.prepare("INSERT INTO steam_metadata_cooldown_v1(id,until_ms) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET until_ms=excluded.until_ms").run(until);
        return until;
      }).immediate();
    } catch (error) {
      if(error instanceof SteamCatalogDeferred)throw error;
      throw new SteamCatalogDeferred(null, "state_unavailable");
    }finally{db?.close();}
  };
  return {
    check() {
      update(until => {
        if (until > now()) throw new SteamCatalogDeferred(until);
        return until;
      });
    },
    defer(header) {
      const time = now();
      // Conservative minimum prevents SKU-by-SKU hammering when headers are
      // absent, zero, malformed or expired. Never shorten a provider cooldown.
      const until = time + Math.max(60_000, retryAfterMs(header, time) ?? 60_000);
      if (!Number.isSafeInteger(until) || !Number.isFinite(new Date(until).getTime()))
        throw new SteamCatalogDeferred(null, "invalid_retry_after");
      return update(existing => Math.max(until, existing));
    },
  };
}
