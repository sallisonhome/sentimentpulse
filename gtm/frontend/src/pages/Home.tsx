import { Link } from "wouter";
import { PageHeader } from "../components/PageHeader";

type CardProps = {
  href: string;
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  primary?: boolean;
  icon: JSX.Element;
};

function ActionCard({ href, eyebrow, title, body, cta, primary, icon }: CardProps) {
  return (
    <Link href={href}>
      <a
        className={`group card-hover p-7 flex flex-col h-full cursor-pointer ${
          primary ? "ring-1 ring-accent/30 bg-gradient-to-b from-accent-glow/40 to-surface" : ""
        }`}
        data-testid={`card-home-${href.replace(/\//g, "")}`}
      >
        <div
          className={`w-10 h-10 rounded-md flex items-center justify-center mb-5 ${
            primary
              ? "bg-accent/15 text-accent border border-accent/30"
              : "bg-surface-elev text-muted border border-border"
          }`}
        >
          {icon}
        </div>
        <div className="eyebrow mb-2">{eyebrow}</div>
        <h2 className="text-lg font-semibold text-ink mb-2">{title}</h2>
        <p className="text-sm text-muted leading-relaxed">{body}</p>
        <div
          className={`mt-6 inline-flex items-center gap-1.5 text-xs font-semibold ${
            primary ? "text-accent" : "text-muted group-hover:text-ink"
          }`}
        >
          {cta}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </div>
      </a>
    </Link>
  );
}

export function Home() {
  return (
    <div>
      <PageHeader
        eyebrow="GTM Studio"
        title="Build go-to-market slide packs in minutes"
        subtitle="Generate audience-tier maps, USP manifestos, channel matrices, and 12-month roadmaps that match the Saber brand — straight to PPTX and PDF."
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <ActionCard
          href="/library"
          eyebrow="Browse"
          title="Open the deck library"
          body="Search, filter, download, or clone any pack that's already been generated."
          cta="Open library"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
            </svg>
          }
        />
        <ActionCard
          primary
          href="/new"
          eyebrow="Create"
          title="+ New slide pack"
          body="Walk a four-step wizard — theme, game, audiences & USPs, release date — then generate a 9-slide preview."
          cta="Start wizard"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          }
        />
        <ActionCard
          href="/example"
          eyebrow="Preview"
          title="Show me an example first"
          body="A 9-slide walkthrough of a finished pack with captions explaining each slide."
          cta="View example"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="4" width="18" height="14" rx="2" />
              <path d="M3 9h18M9 4v14" />
            </svg>
          }
        />
      </div>

      <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="card p-5">
          <div className="eyebrow mb-2">01</div>
          <div className="text-sm font-semibold text-ink mb-1">Audience tiers</div>
          <div className="text-xs text-muted">Nested-ring map of cohorts from highest-intent inward.</div>
        </div>
        <div className="card p-5">
          <div className="eyebrow mb-2">02</div>
          <div className="text-sm font-semibold text-ink mb-1">USP manifesto</div>
          <div className="text-xs text-muted">3–5 unique selling points stacked as a vertical manifesto.</div>
        </div>
        <div className="card p-5">
          <div className="eyebrow mb-2">03</div>
          <div className="text-sm font-semibold text-ink mb-1">Reach matrix + roadmap</div>
          <div className="text-xs text-muted">Per-cohort channel plan plus a six-stage release roadmap.</div>
        </div>
      </div>

      <footer className="mt-16 pt-6 border-t border-border flex items-center justify-between text-xs text-dim">
        <div>GTM Slide Pack Studio · Saber Intelligence Suite</div>
        <Link href="/admin" className="text-muted hover:text-ink" data-testid="link-admin">
          Admin
        </Link>
      </footer>
    </div>
  );
}
