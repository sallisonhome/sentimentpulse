import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { Spinner, ErrorBox } from "../components/EmptyState";
import { api } from "../lib/api";
import type { SlidesResponse } from "../lib/types";

export function Viewer() {
  const { deckId } = useParams<{ deckId: string }>();
  const [slides, setSlides] = useState<SlidesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!deckId) return;
    setLoading(true);
    setErr(null);
    api
      .fetchSlides(deckId)
      .then((d) => {
        setSlides(d);
        setLoading(false);
      })
      .catch((e: Error) => {
        setErr(String(e.message || e));
        setLoading(false);
      });
  }, [deckId]);

  const pngs = slides?.pngs ?? [];
  const total = pngs.length;

  function next() {
    setIdx((i) => Math.min(i + 1, total - 1));
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
  }, [total]);

  const headerActions = slides ? (
    <>
      <span className="chip border-ink/20 text-ink shrink-0">{slides.theme}</span>
      <a
        className="btn-secondary"
        href={api.downloadUrl(deckId!, "pptx")}
        target="_blank"
        rel="noopener"
        data-testid="button-download-pptx"
      >
        Download PPTX
      </a>
      <a
        className="btn-secondary"
        href={api.downloadUrl(deckId!, "pdf")}
        target="_blank"
        rel="noopener"
        data-testid="button-download-pdf"
      >
        Download PDF
      </a>
      <Link href="/library" className="btn-ghost" data-testid="button-back-library">
        ← Back to Library
      </Link>
    </>
  ) : (
    <Link href="/library" className="btn-ghost" data-testid="button-back-library">
      ← Back to Library
    </Link>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Library"
        title={slides ? slides.title : "Deck Viewer"}
        subtitle={
          slides
            ? `${slides.slide_count} slides · ${slides.theme} theme`
            : "Loading deck…"
        }
        actions={headerActions}
      />

      {err && (
        <div className="space-y-4">
          <ErrorBox message={err} />
          <Link href="/library" className="btn-ghost" data-testid="button-back-on-error">
            ← Back to Library
          </Link>
        </div>
      )}

      {loading && !err && (
        <div className="card p-10 flex justify-center">
          <Spinner label="Generating slides…" />
        </div>
      )}

      {!loading && !err && slides && (
        <div className="card overflow-hidden">
          {/* Slide nav bar */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="eyebrow">
              Slide {idx + 1} of {total}
            </div>
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

          {/* Main slide stage — 16:9, dark background */}
          <div className="bg-black/50 aspect-[16/9] flex items-center justify-center">
            {pngs[idx] ? (
              <img
                src={pngs[idx]}
                alt={`Slide ${idx + 1}`}
                className="max-h-full max-w-full"
              />
            ) : (
              <div className="text-dim text-sm">No image for this slide.</div>
            )}
          </div>

          {/* Thumbnail strip */}
          <div className="px-3 py-3 border-t border-border flex gap-2 overflow-x-auto">
            {pngs.map((_, i) => (
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
      )}
    </div>
  );
}
