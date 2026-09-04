import { Link } from "wouter";
import { Shell } from "../components/Shell";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { Skeleton, ErrorBanner } from "../components/misc";
import { PlatformChip } from "../components/chips";

export default function TitlesPage() {
  const games = useAsync(() => api.games(), []);
  return (
    <Shell active="titles" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Titles" }]}>
      <div className="section-h" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>Titles</h2>
        <span className="sub">{games.data?.games.length || 0} games · campaign counts across all platforms</span>
      </div>

      {games.loading ? (
        <Skeleton height={100} count={2} />
      ) : games.error ? (
        <ErrorBanner error={games.error} />
      ) : (
        <div className="strip-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {games.data?.games.map((g) => (
            <Link key={g.game_code} href={`/titles/${encodeURIComponent(g.game_code)}`}>
              <a className="beat" style={{ cursor: "pointer" }}>
                <div className="top">
                  <div>
                    <div className="title">{g.game_label}</div>
                    <div className="meta">{g.game_code}</div>
                  </div>
                  <div className="disc" style={{ fontSize: 24 }}>
                    {g.campaign_count}
                    <small>campaigns</small>
                  </div>
                </div>
                <div className="chips">
                  {g.platforms.map((p) => <PlatformChip key={p} platform={p} />)}
                </div>
              </a>
            </Link>
          ))}
        </div>
      )}
    </Shell>
  );
}
