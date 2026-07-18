import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { ThemeToggle } from "../components/ThemeToggle";
import { Spinner, ErrorBox } from "../components/EmptyState";
import { api } from "../lib/api";
import { useDeckTheme } from "../lib/theme";
import type { PreviewResponse } from "../lib/types";

// Jump-to chips mirror the NewWizard step numbers. Steps 5-7 (Commercial
// Potential, Commercial Risks, Description & Razors) were added by the
// GTM Studio revisions -- they render in the final pack between/after the
// original Steps 1-4 (see gtm_pack output-order docs), but in the intake
// wizard they're additional steps appended after Reach for a natural
// top-to-bottom fill-in flow.
const CHIPS = [
  { step: 1, label: "Theme" },
  { step: 2, label: "Game" },
  { step: 3, label: "Cohorts" },
  { step: 3, label: "USPs" },
  { step: 3, label: "Reach" },
  { step: 4, label: "Commercial potential" },
  { step: 5, label: "GTM Challenges" },
  { step: 6, label: "Description & razors" },
];

export function Preview() {
  const [match, params] = useRoute<{ sessionId: string }>("/preview/:sessionId");
  const [, setLoc] = useLocation();
  const sessionId = params?.sessionId ?? "";
  const { deckTheme } = useDeckTheme();

  const [data, setData] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    // We don't have a GET-session endpoint, so attempt to re-derive from the
    // PNG URL pattern. For initial load, the user has just been routed here
    // from a successful POST /preview, so the session's PNGs exist on disk.
    // We optimistically synthesize the URL list (1..6).
    setLoading(true);
    setErr(null);
    // v6.0 (2026-07-15): 6-slide pack. Roadmap 4.1-4.6 was dropped.
    // 1  Sizing
    // 2  Median Commercial Potential
    // 3  USPs/Pillars
    // 4  Commercial Risks
    // 5  Description & Razors
    // 6  How We Reach
    const pngs = Array.from({ length: 6 }, (_, i) =>
      `${api["resolvePng"] ? "" : ""}/gtm/api/preview/${sessionId}/png/slide_${i + 1}.png`
    );
    // No JSON metadata to fetch — just show the slides. If a slide 404s,
    // the img onError will hide it.
    setData({
      session_id: sessionId,
      theme: deckTheme,
      pngs,
      slide_count: 6,
    });
    setLoading(false);
  }, [sessionId]);

  async function regenerate() {
    // Without inputs in memory, regenerate would need them stored. For now,
    // route the user back to /new to edit and resubmit. A future revision
    // can keep inputs in URL or session.
    setLoc(`/new`);
  }

  async function commit() {
    if (!sessionId) return;
    setCommitting(true);
    setErr(null);
    try {
      const r = await api.commit(sessionId, isPrivate);
      setLoc(`/decks/${r.deck_id}`);
    } catch (e: any) {
      setErr(String(e.message || e));
      setCommitting(false);
    }
  }

  if (!match) return null;
  if (loading) {
    return (
      <div className="card p-10 flex justify-center">
        <Spinner label="Loading preview…" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Preview"
        title="Slide preview"
        subtitle={
          <>
            Session <span className="text-ink font-mono">{sessionId.slice(0, 8)}</span> · 6 slides rendered at {deckTheme === "dark" ? "dark" : "light"} theme.
          </>
        }
        actions={
          <>
            <ThemeToggle />
            <Link href="/new" className="btn-ghost">← Edit inputs</Link>
          </>
        }
      />

      {/* Edit chips */}
      <div className="card p-3 mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="eyebrow mr-1">Jump to</span>
          {CHIPS.map((c, i) => (
            <Link
              key={i}
              href={`/new?step=${c.step}`}
              className="chip hover:border-accent/40 hover:text-accent transition-colors"
              data-testid={`chip-${c.label.toLowerCase()}`}
            >
              <span className="text-dim text-[10px] font-bold mr-1">{i + 1}</span>
              {c.label}
            </Link>
          ))}
          <button
            className="btn-ghost ml-auto"
            onClick={regenerate}
            data-testid="button-regenerate"
          >
            Re-edit & regenerate
          </button>
        </div>
      </div>

      {err && <ErrorBox message={err} />}

      {/* Slide column */}
      <div className="space-y-4">
        {data?.pngs.map((src, i) => (
          <SlideFrame key={i} index={i + 1} src={src} />
        ))}
      </div>

      {/* Commit bar */}
      <div className="sticky bottom-4 mt-8">
        <div className="card-hover border-accent/20 p-4 flex flex-wrap items-center gap-3 shadow-elev">
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="accent-accent"
              data-testid="checkbox-private"
            />
            Mark this deck as private
          </label>
          <div className="text-xs text-dim">
            Private decks are hidden from the public library.
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/new" className="btn-secondary">
              Edit inputs
            </Link>
            <button
              className="btn-primary"
              onClick={commit}
              disabled={committing}
              data-testid="button-generate-final"
            >
              {committing ? "Generating…" : "Generate final deck →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SlideFrame({ src, index }: { src: string; index: number }) {
  const [errored, setErrored] = useState(false);
  return (
    <figure className="card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border text-xs">
        <span className="eyebrow">Slide {index}</span>
        <a
          href={src}
          target="_blank"
          rel="noopener"
          className="text-muted hover:text-ink"
        >
          Open original ↗
        </a>
      </div>
      <div className="bg-black/40">
        {errored ? (
          <div className="aspect-video flex items-center justify-center text-dim text-sm">
            Slide {index} unavailable
          </div>
        ) : (
          <img
            src={src}
            alt={`Slide ${index}`}
            className="w-full block"
            loading="lazy"
            onError={() => setErrored(true)}
          />
        )}
      </div>
    </figure>
  );
}
