import { useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "../components/PageHeader";

export function Admin() {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  function attempt(e: React.FormEvent) {
    e.preventDefault();
    // Phase 2 stub: real auth wires in Phase 6.
    setMsg("Auth not yet wired — Phase 6 will hook this up to the suite SSO layer.");
  }

  return (
    <div className="max-w-md mx-auto">
      <PageHeader
        eyebrow="Admin"
        title="Sign in"
        subtitle="Console access for managing the deck library, scheduling rebuilds, and viewing usage."
      />

      <form className="card p-6 space-y-4" onSubmit={attempt}>
        <div>
          <label className="label">Email</label>
          <input
            className="input"
            type="email"
            value={u}
            onChange={(e) => setU(e.target.value)}
            placeholder="you@saber.games"
            data-testid="input-email"
          />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            value={p}
            onChange={(e) => setP(e.target.value)}
            placeholder="••••••••"
            data-testid="input-password"
          />
        </div>
        <button className="btn-primary w-full" type="submit" data-testid="button-signin">
          Sign in
        </button>
        {msg && (
          <div className="text-xs text-muted border border-border bg-surface-elev rounded-md p-3">
            {msg}
          </div>
        )}
      </form>

      <div className="mt-6 text-xs text-dim flex items-center justify-between">
        <Link href="/" className="hover:text-ink">← Back to home</Link>
        <span>Phase 6 will replace this stub with real auth.</span>
      </div>
    </div>
  );
}
