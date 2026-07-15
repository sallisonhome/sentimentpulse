import { useEffect, useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { ThemeToggle } from "../components/ThemeToggle";
import { Spinner, ErrorBox } from "../components/EmptyState";
import { api } from "../lib/api";
import { useDeckTheme } from "../lib/theme";

// v6.0 pack (locked 2026-07-15): 6 slides, roadmap dropped.
// 1  Sizing
// 2  Median Commercial Potential
// 3  USP Manifesto
// 4  Commercial Risks
// 5  Description & Razors
// 6  How We Reach
// Example deck is "Blackwood Hollow" (fictional psychological horror dummy data).
const CAPTIONS = [
  {
    title: "Slide 1 — Target Audiences & Sizing",
    body: "Nested circles map audience tiers from innermost (highest intent) outward.",
  },
  {
    title: "Slide 2 — Median Commercial Potential",
    body: "Genre Pulse comp-set medians benchmark revenue, units, price, and hours — then project per-platform.",
  },
  {
    title: "Slide 3 — USP Manifesto",
    body: "Up to five unique selling points stacked as a vertical manifesto, each with proof and a GTM strategy line.",
  },
  {
    title: "Slide 4 — Commercial Risks",
    body: "Up to five launch risks by threat level, each with proof and a concrete mitigation.",
  },
  {
    title: "Slide 5 — Game Description & Razors",
    body: "A 100-word product description plus 20-word and 10-word taglines.",
  },
  {
    title: "Slide 6 — How We Reach",
    body: "Per-cohort channel matrix.",
  },
];

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
  const caption = CAPTIONS[idx];

  return (
    <div>
      <PageHeader
        eyebrow="Example"
        title="Walk through a finished pack"
        subtitle="Six slides — audience sizing, commercial potential, USPs, commercial risks, description & razors, and reach plan."
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
