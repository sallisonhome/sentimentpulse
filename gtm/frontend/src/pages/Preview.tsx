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
    setLoading(true);
    setErr(null);
    // Read the PNG URL list that NewWizard stashed in sessionStorage after
    // POST /preview succeeded. This gives us the REAL backend filenames
    // (per-deck slugs, not generic 'slide_N.png'). Fallback to synthesized
    // URLs only if sessionStorage is missing the entry -- e.g. user opened
    // the preview link in a new tab or bookmarked it.
    //
    // v7.0 (2026-07-18 polish pass): slide count is now DYNAMIC (6-8).
    //   1 Sizing / 2 Commercial Potential / 3(-4) USPs / 4(-5) Risks /
    //   Description & Razors / How We Reach
    // The USP and Commercial Risks sub-decks each split into 2 slides when
    // they carry 4-5 items (locked split rule), so the pack can be 6, 7,
    // or 8 slides depending on how many USPs/risks the user entered.
    // FALLBACK_SLIDE_COUNT is only used if sessionStorage is missing the
    // stashed preview payload entirely (e.g. bookmark/new-tab open) -- it's
    // a legacy-URL best-effort guess, not an assumption enforced elsewhere.
    const FALLBACK_SLIDE_COUNT = 6;
    let pngs: string[];
    let theme = deckTheme;
    let slide_count = FALLBACK_SLIDE_COUNT;
    try {
      const stashed = sessionStorage.getItem(`gtm:preview:${sessionId}`);
      if (stashed) {
        const parsed = JSON.parse(stashed);
        pngs = Array.isArray(parsed.pngs) ? parsed.pngs : [];
        theme = parsed.theme || deckTheme;
        slide_count = parsed.slide_count || pngs.length || FALLBACK_SLIDE_COUNT;
      } else {
        // Fallback: legacy URL pattern. These will 404 on modern backends
        // that use per-deck slug filenames -- but at least the page renders
        // and the user sees clear 'Slide N unavailable' messages instead
        // of a hang. In that case, redirect the user back to the wizard.
        // Uses the minimum guaranteed slide count (6) since we have no
        // actual slide_count to go on in this fallback path.
        pngs = Array.from({ length: FALLBACK_SLIDE_COUNT }, (_, i) =>
          `/gtm/api/preview/${sessionId}/png/slide_${i + 1}.png`
        );
      }
    } catch {
      pngs = [];
    }
    setData({
      session_id: sessionId,
      theme,
      pngs,
      slide_count,
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
            Session <span className="text-ink font-mono">{sessionId.slice(0, 8)}</span> · {data?.pngs.length ?? data?.slide_count ?? ""} slides rendered at {deckTheme === "dark" ? "dark" : "light"} theme.
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
