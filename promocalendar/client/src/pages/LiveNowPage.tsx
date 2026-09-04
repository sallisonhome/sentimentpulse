import { Shell } from "../components/Shell";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { getToday, todayHuman } from "../lib/today";
import { BeatCard } from "../components/BeatCard";
import { Section, Skeleton, ErrorBanner, EmptyNoUpload } from "../components/misc";
import type { Beat } from "../lib/api";

/**
 * Full list of every campaign currently in-flight. Reached from the "View
 * all N →" link on the Calendar landing's Live Now strip. Steam-biased and
 * grouped by platform so it reads as a natural expansion of the compact
 * strip on the front page.
 */
export default function LiveNowPage() {
  const today = getToday();
  const me = useAsync(() => api.me(), []);
  const cals = useAsync(() => api.calendars(), []);
  const live = useAsync(() => api.liveNow(today), [today]);

  const activeUpload = cals.data?.calendars.find((c) => c.id === "saber")?.active_upload;
  if (cals.data && !activeUpload) {
    return (
      <Shell active="calendar" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Live Now" }]}>
        <EmptyNoUpload canUpload={!!me.data?.can_upload} />
      </Shell>
    );
  }

  const beats: Beat[] = live.data?.beats || [];
  const grouped = groupByPlatform(beats);

  return (
    <Shell active="calendar" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Live Now" }]}>
      <Section
        title="Promos Live Now"
        right={
          <span className="sub">
            {live.loading
              ? "Loading…"
              : `${beats.length} campaign${beats.length === 1 ? "" : "s"} in flight on ${todayHuman(today)} · Steam first`}
          </span>
        }
      >
        {live.loading ? (
          <Skeleton height={220} count={1} />
        ) : live.error ? (
          <ErrorBanner error={live.error} />
        ) : beats.length === 0 ? (
          <div className="empty" style={{ padding: "20px 24px" }}>
            <p>No campaigns currently in flight. Check back after the next scheduled sale window.</p>
          </div>
        ) : (
          <div className="live-now-groups">
            {grouped.map(([platform, list]) => (
              <div key={platform} className="live-now-group">
                <div className="live-now-group-h">
                  <span className={`chip plat-${platClass(platform)}`}>{platform}</span>
                  <span className="sub">
                    {list.length} campaign{list.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="strip-grid">
                  {list.map((b) => (
                    <BeatCard key={b.campaign_id} beat={b} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Shell>
  );
}

// Preserve incoming order (Steam first from server), collect all beats for
// each platform, then emit groups in first-seen order so the platform sort
// from the backend carries through.
function groupByPlatform(beats: Beat[]): [string, Beat[]][] {
  const groups = new Map<string, Beat[]>();
  for (const b of beats) {
    const p = b.platform || "Other";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(b);
  }
  return Array.from(groups.entries());
}

function platClass(p: string): string {
  const s = p.toLowerCase();
  if (s === "steam") return "steam";
  if (s === "microsoft") return "ms";
  if (s === "sony") return "sony";
  return "other";
}
