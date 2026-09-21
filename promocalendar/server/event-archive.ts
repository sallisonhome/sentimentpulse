import { raw } from "./db.js";
import type { EventDetail } from "./storage.js";

/** No FK to uploads/campaigns: workbook replacement must not erase history. */
export function saveArchivedEvent(calendar: string, detail: EventDetail): void {
  raw.prepare(`INSERT INTO event_archive(calendar,event_key,detail_json)
    VALUES(?,?,?) ON CONFLICT(calendar,event_key) DO UPDATE SET detail_json=excluded.detail_json
    WHERE detail_json != excluded.detail_json`)
    .run(calendar, detail.event_key, JSON.stringify(detail));
}

export function archivedEvents(calendar: string): EventDetail[] {
  return (raw.prepare("SELECT detail_json FROM event_archive WHERE calendar=?")
    .all(calendar) as { detail_json: string }[]).map(r => JSON.parse(r.detail_json));
}

export function archivedEvent(calendar: string, key: string): EventDetail | null {
  const r = raw.prepare("SELECT detail_json FROM event_archive WHERE calendar=? AND event_key=?")
    .get(calendar, key) as { detail_json: string } | undefined;
  return r ? JSON.parse(r.detail_json) : null;
}
