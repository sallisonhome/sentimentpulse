import { useEffect, useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";

type Tab = "decks" | "trash" | "audit" | "password";

export function Admin() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.adminSession().then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);

  async function attemptLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.adminLogin(password);
      setAuthed(true);
    } catch (err: any) {
      setError(err.message || "Sign-in failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (authed === null) {
    return <div className="text-muted text-sm">Checking session…</div>;
  }

  if (!authed) {
    return (
      <div className="max-w-md mx-auto">
        <PageHeader
          eyebrow="Admin"
          title="Sign in"
          subtitle="Console access for deck management, trash recovery, audit log, and password rotation."
        />
        <form className="card p-6 space-y-4" onSubmit={attemptLogin}>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus
              data-testid="input-password"
            />
          </div>
          <button
            className="btn-primary w-full"
            type="submit"
            disabled={submitting || !password}
            data-testid="button-signin"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          {error && (
            <div className="text-xs text-red-400 border border-red-900 bg-red-950/30 rounded-md p-3">
              {error}
            </div>
          )}
        </form>
        <div className="mt-6 text-xs text-dim">
          <Link href="/" className="hover:text-ink">← Back to home</Link>
        </div>
      </div>
    );
  }

  return <Console onLogout={() => setAuthed(false)} />;
}

function Console({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("decks");

  async function logout() {
    try { await api.adminLogout(); } catch {}
    onLogout();
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4">
        <PageHeader
          eyebrow="Admin Console"
          title="Library administration"
          subtitle="Soft-delete, restore, hard-purge, audit log, and password rotation."
        />
        <button onClick={logout} className="btn-secondary text-sm">Sign out</button>
      </div>

      <div className="flex gap-2 mb-4 border-b border-border">
        {(["decks", "trash", "audit", "password"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
            data-testid={`tab-${t}`}
          >
            {t === "decks" ? "All decks" : t === "trash" ? "Trash" : t === "audit" ? "Audit log" : "Change password"}
          </button>
        ))}
      </div>

      {tab === "decks" && <DecksTab />}
      {tab === "trash" && <TrashTab />}
      {tab === "audit" && <AuditTab />}
      {tab === "password" && <PasswordTab />}
    </div>
  );
}

function DecksTab() {
  const [decks, setDecks] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.adminLibrary().then((d) => setDecks(d.decks)).catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function softDelete(id: string) {
    if (!confirm("Soft-delete this deck? It will be moved to Trash for 30 days.")) return;
    try { await api.adminDelete(id); load(); } catch (e: any) { alert(e.message); }
  }

  const activeDecks = decks.filter((d) => !d.deleted_at);

  if (error) return <div className="text-red-400 text-sm">{error}</div>;

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted">{activeDecks.length} active deck(s) — including private</div>
      {activeDecks.map((d) => (
        <div key={d.id} className="card p-4 flex items-center justify-between" data-testid={`deck-${d.id}`}>
          <div className="min-w-0">
            <div className="font-medium truncate">{d.title} {d.is_private ? <span className="text-amber-400 text-xs ml-2">PRIVATE</span> : null}</div>
            <div className="text-xs text-muted">{d.genre} · {d.theme} · created {new Date(d.created_at).toLocaleDateString()}</div>
          </div>
          <button onClick={() => softDelete(d.id)} className="btn-danger text-xs" data-testid={`delete-${d.id}`}>Soft delete</button>
        </div>
      ))}
      {activeDecks.length === 0 && <div className="text-muted text-sm py-8 text-center">No active decks.</div>}
    </div>
  );
}

function TrashTab() {
  const [decks, setDecks] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.adminLibrary().then((d) => setDecks(d.decks)).catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function restore(id: string) {
    try { await api.adminRestore(id); load(); } catch (e: any) { alert(e.message); }
  }
  async function purge(id: string) {
    if (!confirm("Hard-delete this deck? This CANNOT be undone — files and DB row will be removed permanently.")) return;
    try { await api.adminPurge(id); load(); } catch (e: any) { alert(e.message); }
  }

  const trashed = decks.filter((d) => d.deleted_at);

  if (error) return <div className="text-red-400 text-sm">{error}</div>;

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted">
        {trashed.length} deck(s) in trash · auto-purged after 30 days
      </div>
      {trashed.map((d) => (
        <div key={d.id} className="card p-4 flex items-center justify-between" data-testid={`trash-${d.id}`}>
          <div className="min-w-0">
            <div className="font-medium truncate">{d.title}</div>
            <div className="text-xs text-muted">
              {d.genre} · {d.theme} · deleted {new Date(d.deleted_at).toLocaleString()}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => restore(d.id)} className="btn-secondary text-xs">Restore</button>
            <button onClick={() => purge(d.id)} className="btn-danger text-xs">Purge</button>
          </div>
        </div>
      ))}
      {trashed.length === 0 && <div className="text-muted text-sm py-8 text-center">Trash is empty.</div>}
    </div>
  );
}

function AuditTab() {
  const [actions, setActions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminAudit().then((r) => setActions(r.actions)).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="text-red-400 text-sm">{error}</div>;
  if (actions.length === 0) return <div className="text-muted text-sm py-8 text-center">No audit entries yet.</div>;

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-surface-elev text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Action</th>
            <th className="px-3 py-2 text-left">Target</th>
            <th className="px-3 py-2 text-left">IP</th>
            <th className="px-3 py-2 text-left">Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a.id} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{a.action}</td>
              <td className="px-3 py-2 text-muted font-mono text-xs">{a.target_deck_id?.slice(0, 8) || "—"}</td>
              <td className="px-3 py-2 text-muted">{a.ip_address || "—"}</td>
              <td className="px-3 py-2 text-muted">{new Date(a.timestamp).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PasswordTab() {
  const [newP, setNewP] = useState("");
  const [confirmP, setConfirmP] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setMsg(null);
    if (newP !== confirmP) { setError("Passwords don't match"); return; }
    if (newP.length < 6) { setError("Password must be at least 6 characters"); return; }
    setSubmitting(true);
    try {
      await api.adminChangePassword(newP);
      setMsg("Password updated.");
      setNewP(""); setConfirmP("");
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  return (
    <form onSubmit={submit} className="card p-6 max-w-md space-y-4">
      <div>
        <label className="label">New password</label>
        <input className="input" type="password" value={newP} onChange={(e) => setNewP(e.target.value)} />
      </div>
      <div>
        <label className="label">Confirm new password</label>
        <input className="input" type="password" value={confirmP} onChange={(e) => setConfirmP(e.target.value)} />
      </div>
      <button className="btn-primary" type="submit" disabled={submitting}>
        {submitting ? "Updating…" : "Update password"}
      </button>
      {msg && <div className="text-xs text-emerald-400">{msg}</div>}
      {error && <div className="text-xs text-red-400">{error}</div>}
    </form>
  );
}
