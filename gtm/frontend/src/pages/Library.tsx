import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, Spinner, ErrorBox } from "../components/EmptyState";
import { api } from "../lib/api";
import type { DeckSummary, LibraryResponse } from "../lib/types";

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
}: {
  d: DeckSummary;
  onClone: (id: string) => void;
  isCloning: boolean;
}) {
  const dateStr = formatDate(d.release_date);
  return (
    <div className="card-hover p-5 flex flex-col" data-testid={`card-deck-${d.id}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-ink truncate">{d.title}</div>
          <div className="text-xs text-muted truncate mt-0.5">{d.genre}</div>
        </div>
        <span
          className={`shrink-0 chip ${
            d.theme === "dark"
              ? "border-ink/20 text-ink"
              : "border-accent/30 text-accent"
          }`}
        >
          {d.theme}
        </span>
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
