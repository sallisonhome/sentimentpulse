import { Link, useRoute } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";

export function Download() {
  const [, params] = useRoute("/decks/:deckId");
  const id = params?.deckId || "";
  return (
    <div>
      <PageHeader
        eyebrow="Ready"
        title="Your slide pack is ready"
        subtitle={
          <>
            Deck <span className="font-mono text-ink">{id.slice(0, 8)}</span> has been generated. Download below or open the library for everything you've ever built.
          </>
        }
        actions={
          <Link href="/library" className="btn-ghost">
            ← Open library
          </Link>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <DownloadCard
          format="pptx"
          title="Download PPTX"
          desc="Editable PowerPoint file. Native Saber template — fonts, colors, and slide masters intact."
          href={api.downloadUrl(id, "pptx")}
        />
        <DownloadCard
          format="pdf"
          title="Download PDF"
          desc="Print-ready PDF. Useful for sharing with partners or attaching to a deal review."
          href={api.downloadUrl(id, "pdf")}
        />
      </div>

      <div className="mt-10 card p-5">
        <div className="eyebrow mb-2">What's next</div>
        <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
          <li>Iterate the inputs and regenerate from <Link href="/new" className="text-accent hover:underline">+ New slide pack</Link>.</li>
          <li>Browse, search, and re-download anything previously built in the <Link href="/library" className="text-accent hover:underline">library</Link>.</li>
          <li>The deck stays available at this URL — bookmark it or share with the team.</li>
        </ul>
      </div>
    </div>
  );
}

function DownloadCard({
  format,
  title,
  desc,
  href,
}: {
  format: "pptx" | "pdf";
  title: string;
  desc: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="card-hover p-7 flex flex-col"
      data-testid={`button-download-${format}`}
    >
      <div className="w-12 h-12 rounded-md bg-accent-glow border border-accent/30 text-accent flex items-center justify-center mb-5">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </div>
      <div className="eyebrow mb-1">{format.toUpperCase()}</div>
      <div className="text-lg font-semibold text-ink mb-2">{title}</div>
      <p className="text-sm text-muted">{desc}</p>
      <div className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
        Download
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </div>
    </a>
  );
}
