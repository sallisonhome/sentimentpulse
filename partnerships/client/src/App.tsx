import { useEffect, useState } from "react";

type Health = { ok: boolean; app: string; version: string; time: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/partnerships/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 font-sans">
      <header className="border-b border-neutral-800 px-8 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-amber-400" />
          <h1 className="text-lg font-semibold tracking-tight">
            Saber Publishing Partnerships
          </h1>
        </div>
        <a
          href="/"
          className="text-sm text-neutral-400 hover:text-neutral-200"
        >
          ← Suite home
        </a>
      </header>

      <section className="mx-auto max-w-4xl px-8 py-16">
        <p className="text-sm uppercase tracking-widest text-amber-400/80">
          Coming soon
        </p>
        <h2 className="mt-3 text-3xl font-semibold">
          Track every value-add partnership across the Saber slate.
        </h2>
        <p className="mt-4 max-w-2xl text-neutral-400">
          This app is the source of truth for revenue and marketing
          opportunities Saber isn't paying cash for — physical retail,
          incremental revenue, collectors editions, and marketing beats. Titles
          sync automatically from SignalPulse.
        </p>

        <div className="mt-10 rounded-lg border border-neutral-800 bg-neutral-900/50 p-6">
          <p className="text-xs uppercase tracking-wider text-neutral-500">
            Backend status
          </p>
          {error && (
            <p className="mt-2 text-sm text-red-400">Health check failed: {error}</p>
          )}
          {!error && !health && (
            <p className="mt-2 text-sm text-neutral-500">Checking…</p>
          )}
          {health && (
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-neutral-500">App</dt>
              <dd className="font-mono">{health.app}</dd>
              <dt className="text-neutral-500">Version</dt>
              <dd className="font-mono">{health.version}</dd>
              <dt className="text-neutral-500">Time</dt>
              <dd className="font-mono">{health.time}</dd>
              <dt className="text-neutral-500">OK</dt>
              <dd className="font-mono">{String(health.ok)}</dd>
            </dl>
          )}
        </div>

        <p className="mt-8 text-xs text-neutral-600">
          Spec:{" "}
          <a
            className="underline hover:text-neutral-400"
            href="https://github.com/sallisonhome/sentimentpulse/blob/main/docs/partnerships/README.md"
          >
            docs/partnerships/README.md
          </a>
        </p>
      </section>
    </main>
  );
}
