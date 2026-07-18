import { useEffect, useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { ThemeToggle } from "../components/ThemeToggle";
import { Spinner, ErrorBox } from "../components/EmptyState";
import { api } from "../lib/api";
import { useDeckTheme } from "../lib/theme";

// v7.0 pack (2026-07-18 polish pass): slide count is DYNAMIC (6-8 slides).
// The USP and Commercial Risks sub-decks each split into 2 slides when
// they carry 4-5 items (locked split rule: <=3 items = 1 slide, 4-5 items
// = 2 slides), so CAPTIONS below is a best-effort static index -- it no
// longer maps 1:1 to slide position when a sub-deck splits. The example
// deck ("Blackwood Hollow", fictional psychological horror dummy data)
// currently has 5 USPs + 5 risks, so it renders 8 slides:
//   1  Sizing
//   2  Median Commercial Potential
//   3-4  USP Manifesto (1 of 2, 2 of 2)
//   5-6  GTM Challenges (1 of 2, 2 of 2)
//   7  Description & Razors
//   8  How We Reach
// CAPTIONS intentionally stays a 6-entry array keyed to the LOGICAL section
// (not slide position) -- getCaption() below maps the current slide index
// to the right caption even when a section spans 2 physical slides, and
// falls back to a generic caption if a slide has no better match.
const CAPTIONS = [
  {
    title: "Slide 1 — Target Audiences & Sizing",
    body: "Nested circles map audience tiers from innermost (highest intent) outward.",
  },
  {
    title: "Median Commercial Potential",
    body: "Genre Pulse comp-set medians benchmark revenue, units, price, and hours — then project per-platform.",
  },
  {
    title: "USP Manifesto",
    body: "Up to five unique selling points stacked as a vertical manifesto, each with proof and a GTM strategy line. Splits across two slides at 4-5 USPs.",
  },
  {
    title: "GTM Challenges",
    body: "Up to five launch challenges by threat level, each with proof and a concrete mitigation. Splits across two slides at 4-5 challenges.",
  },
  {
    title: "Game Description & Razors",
    body: "A 100-word product description plus 20-word and 10-word taglines.",
  },
  {
    title: "How We Reach",
    body: "Per-cohort channel matrix with potential audience size for each cohort.",
  },
];

// Best-effort caption lookup that degrades gracefully when the sub-deck
// split logic pushes total slide count above CAPTIONS.length (6). Uses the
// slide's own eyebrow-derived index when available (pngs/captions are both
// arrays of the SAME rendered pack, so for indexes beyond CAPTIONS.length-1
// we fall back to the last caption's topic rather than showing a blank
// title/body panel.
function getCaption(idx: number) {
  if (idx < CAPTIONS.length) return CAPTIONS[idx];
  return CAPTIONS[CAPTIONS.length - 1];
}

export function Example() {
  const { deckTheme } = useDeckTheme();
  const [themes, setThemes] = useState<{ dark: string[]; light: string[] }>({
    dark: [],
    light: [],
  });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    api
      .example()
      .then((d: any) => {
        // Backend returns { themes: { dark: [...], light: [...] } }
        setThemes({
          dark: d.themes?.dark || [],
          light: d.themes?.light || [],
        });
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e.message || e));
        setLoading(false);
      });
  }, []);

  const pngs = themes[deckTheme] || [];

  function next() {
    setIdx((i) => Math.min(i + 1, Math.max(pngs.length, CAPTIONS.length) - 1));
  }
  function prev() {
    setIdx((i) => Math.max(i - 1, 0));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pngs.length]);

  const total = Math.max(pngs.length, CAPTIONS.length);
  const caption = getCaption(idx);

  return (
    <div>
      <PageHeader
        eyebrow="Example"
        title="Walk through a finished pack"
        subtitle="Audience sizing, commercial potential, USPs, GTM challenges, description & razors, and reach plan."
        actions={
          <>
            <ThemeToggle />
            <Link href="/new" className="btn-primary">+ New slide pack</Link>
          </>
        }
      />

      {err && <ErrorBox message={err} />}
      {loading && (
        <div className="card p-10 flex justify-center">
          <Spinner label="Loading example pack…" />
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* Slide stage */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="eyebrow">Slide {idx + 1} of {total}</div>
              <div className="flex items-center gap-2">
                <button
                  className="btn-ghost"
                  onClick={prev}
                  disabled={idx === 0}
                  data-testid="button-prev"
                >
                  ← Prev
                </button>
                <button
                  className="btn-primary"
                  onClick={next}
                  disabled={idx >= total - 1}
                  data-testid="button-next"
                >
                  Next →
                </button>
              </div>
            </div>
            <div className="bg-black/50 aspect-[16/9] flex items-center justify-center">
              {pngs[idx] ? (
                <img
                  src={pngs[idx]}
                  alt={caption?.title || `Slide ${idx + 1}`}
                  className="max-h-full max-w-full"
                />
              ) : (
                <div className="text-dim text-sm">No image for this slide.</div>
              )}
            </div>
            {/* Thumbnails */}
            <div className="px-3 py-3 border-t border-border flex gap-2 overflow-x-auto">
              {Array.from({ length: total }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setIdx(i)}
                  className={`shrink-0 w-16 h-9 rounded border text-[10px] flex items-center justify-center ${
                    i === idx
                      ? "border-accent text-accent bg-accent-glow"
                      : "border-border text-dim hover:border-border-strong"
                  }`}
                  data-testid={`thumb-${i}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>

          {/* Caption rail */}
          <aside className="card p-5 h-fit lg:sticky lg:top-6">
            <div className="eyebrow mb-2">Caption</div>
            <h3 className="text-lg font-semibold text-ink mb-2">{caption?.title}</h3>
            <p className="text-sm text-muted">{caption?.body}</p>
            <div className="mt-6 pt-4 border-t border-border text-xs text-dim">
              <div className="flex items-center justify-between">
                <span>Theme</span>
                <span className="text-ink">{deckTheme}</span>
              </div>
            </div>
            <Link href="/new" className="btn-primary w-full mt-5 justify-center">
              Build mine
            </Link>
          </aside>
        </div>
      )}
    </div>
  );
}
