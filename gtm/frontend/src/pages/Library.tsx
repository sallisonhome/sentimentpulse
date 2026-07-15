import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, Spinner, ErrorBox } from "../components/EmptyState";
import { api, ApiError } from "../lib/api";
import type { DeckSummary, LibraryResponse, TranslateConflictDetail } from "../lib/types";

export function Library() {
  const [, setLoc] = useLocation();
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [theme, setTheme] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cloning, setCloning] = useState<string | null>(null);
  // Phase 4: tracks the source deck id currently being translated (for the
  // per-card spinner) and any translate-specific error to show inline.
  const [translating, setTranslating] = useState<string | null>(null);
  const [translateErr, setTranslateErr] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setErr(null);
    api
      .library({
        q: q || undefined,
        theme: theme || undefined,
        from_date: from || undefined,
        to_date: to || undefined,
        page_size: 50,
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e.message || e));
        setLoading(false);
      });
  }
  useEffect(load, []); // initial load

  async function cloneAndEdit(id: string) {
    setCloning(id);
    try {
      const { theme, inputs } = await api.clone(id);
      const payload = encodeURIComponent(JSON.stringify({ theme, inputs }));
      setLoc(`/new?clone=${payload}`);
    } catch (e: any) {
      setErr(String(e.message || e));
      setCloning(null);
    }
  }

  // Phase 4: kick off EN -> RU translation for a deck. On success, redirect
  // straight to the new RU deck's viewer. On 409 (already translated), route
  // to the existing RU deck instead of erroring -- the backend returns
  // existing_deck_id specifically so we can do this. Any other failure
  // (e.g. 502 because Sonar has no API key configured) surfaces as an
  // inline error banner rather than a silent no-op.
  async function translateToRu(id: string) {
    setTranslating(id);
    setTranslateErr(null);
    try {
      const res = await api.translate(id, "ru");
      setLoc(`/library/${res.deck_id}/view`);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) {
        const detail = e.detail as TranslateConflictDetail | undefined;
        if (detail?.existing_deck_id) {
          setLoc(`/library/${detail.existing_deck_id}/view`);
          return;
        }
      }
      setTranslateErr(
        e instanceof ApiError
          ? e.message
          : `Translation failed: ${String(e.message || e)}`
      );
      setTranslating(null);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Library"
        title="Slide pack library"
        subtitle="Search and filter every GTM pack the team has generated. Download to PPTX or PDF, or clone and edit any pack as a starting point."
        actions={
          <Link href="/new" className="btn-primary" data-testid="link-new-pack">
            + New slide pack
          </Link>
        }
      />

      <div className="card p-4 mb-6 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <label className="label">Search</label>
          <input
            className="input"
            placeholder="Title or genre…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            data-testid="input-search"
          />
        </div>
        <div>
          <label className="label">Theme</label>
          <select
            className="input"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            data-testid="select-theme"
          >
            <option value="">Any</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div>
          <label className="label">From</label>
          <input
            type="date"
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="input-from"
          />
        </div>
        <div>
          <label className="label">To</label>
          <input
            type="date"
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="input-to"
          />
        </div>
        <div className="md:col-span-4 flex items-center justify-end gap-2">
          <button
            className="btn-ghost"
            onClick={() => {
              setQ("");
              setTheme("");
              setFrom("");
              setTo("");
              setTimeout(load, 0);
            }}
          >
            Reset
          </button>
          <button className="btn-secondary" onClick={load} data-testid="button-apply-filters">
            Apply filters
          </button>
        </div>
      </div>

      {loading && (
        <div className="card p-10 flex justify-center">
          <Spinner label="Loading library…" />
        </div>
      )}
      {err && <ErrorBox message={err} />}
      {translateErr && <ErrorBox message={translateErr} />}
      {!loading && !err && data && data.decks.length === 0 && (
        <EmptyState
          title="No decks yet"
          description="When a slide pack is generated it'll show up here. Try creating one from scratch."
          action={
            <Link href="/new" className="btn-primary">
              Create the first pack
            </Link>
          }
        />
      )}
      {!loading && !err && data && data.decks.length > 0 && (
        <>
          <div className="text-xs text-muted mb-3">
            Showing {data.decks.length} of {data.total} decks
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.decks.map((d) => (
              <DeckCard
                key={d.id}
                d={d}
                onClone={cloneAndEdit}
                isCloning={cloning === d.id}
                onTranslate={translateToRu}
                isTranslating={translating === d.id}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DeckCard({
  d,
  onClone,
  isCloning,
  onTranslate,
  isTranslating,
}: {
  d: DeckSummary;
  onClone: (id: string) => void;
  isCloning: boolean;
  onTranslate: (id: string) => void;
  isTranslating: boolean;
}) {
  const dateStr = formatDate(d.release_date);
  // Phase 4: `language` defaults to "en" for any pre-Phase-4 row (backend
  // schema default), so this is always defined even for old decks.
  const isRu = d.language === "ru";
  return (
    <div className="card-hover p-5 flex flex-col" data-testid={`card-deck-${d.id}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-ink truncate">{d.title}</div>
          <div className="text-xs text-muted truncate mt-0.5">{d.genre}</div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span
            className={`chip ${
              d.theme === "dark"
                ? "border-ink/20 text-ink"
                : "border-accent/30 text-accent"
            }`}
          >
            {d.theme}
          </span>
          <span
            className={`chip ${
              isRu ? "border-accent/40 text-accent" : "border-ink/15 text-muted"
            }`}
            data-testid={`badge-language-${d.id}`}
            title={
              isRu && d.translated_from_deck_id
                ? `Translated from deck ${d.translated_from_deck_id}`
                : undefined
            }
          >
            {isRu ? "RU" : "EN"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted mb-5">
        <div>
          <div className="eyebrow">Release</div>
          <div className="mt-0.5 text-ink/80">{dateStr}</div>
        </div>
        <div>
          <div className="eyebrow">Created</div>
          <div className="mt-0.5 text-ink/80">{formatDate(d.created_at)}</div>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Link
          className="btn-primary"
          href={`/library/${d.id}/view`}
          data-testid={`button-view-${d.id}`}
        >
          View
        </Link>
        <a
          className="btn-secondary"
          href={api.downloadUrl(d.id, "pptx")}
          target="_blank"
          rel="noopener"
          data-testid={`button-pptx-${d.id}`}
        >
          PPTX
        </a>
        <a
          className="btn-secondary"
          href={api.downloadUrl(d.id, "pdf")}
          target="_blank"
          rel="noopener"
          data-testid={`button-pdf-${d.id}`}
        >
          PDF
        </a>
        {/* Only offer translation from an EN source deck -- translating an
            RU deck (or chaining RU->RU) is out of scope for v1, and the
            backend rejects it with a 400 anyway. */}
        {!isRu && (
          <button
            className="btn-ghost"
            onClick={() => onTranslate(d.id)}
            disabled={isTranslating}
            data-testid={`button-translate-ru-${d.id}`}
            title="Translate this deck to Russian"
          >
            {isTranslating ? "Translating…" : "Translate → RU"}
          </button>
        )}
        <button
          className="btn-ghost ml-auto"
          onClick={() => onClone(d.id)}
          disabled={isCloning}
          data-testid={`button-clone-${d.id}`}
        >
          {isCloning ? "Cloning…" : "Clone & edit"}
        </button>
      </div>
    </div>
  );
}

function formatDate(s?: string) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return s;
  }
}
