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
        subtitle="Answer a four-step questionnaire about your game and release date. GTM Studio renders a 9-slide pack — audience tiers, USP manifesto, reach plan, and a 12-month work-back roadmap — ready to download as PPTX or PDF."
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

      {/* ── How it works ───────────────────────────────────────────────────────────*/}
      <section className="mt-14">
        <div className="eyebrow mb-3">How it works</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* You provide */}
          <div className="card p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-7 h-7 rounded-md bg-surface-elev border border-border flex items-center justify-center text-xs font-semibold text-muted">1</div>
              <h3 className="text-sm font-semibold text-ink uppercase tracking-wide">You provide</h3>
            </div>
            <ul className="space-y-3 text-sm text-muted">
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">•</span>
                <span><span className="text-ink font-medium">Game basics</span> — title, genre, and whether it's a sequel, IP-based, or new.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">•</span>
                <span><span className="text-ink font-medium">Audience tiers</span> — four cohorts (innermost → broadest) with names and sizes.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">•</span>
                <span><span className="text-ink font-medium">3–5 USPs</span> — short title, supporting sentence, and proof point each.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">•</span>
                <span><span className="text-ink font-medium">Reach plan</span> — channel, message, and KPI for each of the four cohorts.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">•</span>
                <span><span className="text-ink font-medium">Release date</span> — anchors the 12-month work-back schedule.</span>
              </li>
            </ul>
          </div>

          {/* You get back */}
          <div className="card p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/30 flex items-center justify-center text-xs font-semibold text-accent">2</div>
              <h3 className="text-sm font-semibold text-ink uppercase tracking-wide">You get back</h3>
            </div>
            <ul className="space-y-3 text-sm text-muted">
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">·</span>
                <span><span className="text-ink font-medium">Slide 1 — Audience tiers.</span> Nested-circle chart sized to your cohorts.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">·</span>
                <span><span className="text-ink font-medium">Slide 2 — USP manifesto.</span> Vertical stack of your selling points with proofs.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">·</span>
                <span><span className="text-ink font-medium">Slide 3 — How we reach.</span> Per-cohort channel matrix with mini audience map.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">·</span>
                <span><span className="text-ink font-medium">Slides 4.1–4.5 — GTM roadmap.</span> Phased work-back from T-12 months through T+365 days, with calendar dates computed from your release date.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-accent mt-[2px]">·</span>
                <span><span className="text-ink font-medium">Slide 4.6 — Key dates.</span> At-a-glance summary of every calendar-anchored milestone.</span>
              </li>
              <li className="flex gap-2.5 pt-1 mt-2 border-t border-border">
                <span className="text-accent mt-[2px]">→</span>
                <span className="text-ink font-medium">Download as PPTX or PDF. Editable, ready to share.</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <footer className="mt-16 pt-6 border-t border-border flex items-center justify-between text-xs text-dim">
        <div>GTM Slide Pack Studio · Saber Intelligence Suite</div>
        <Link href="/admin" className="text-muted hover:text-ink" data-testid="link-admin">
          Admin
        </Link>
      </footer>
    </div>
  );
}
