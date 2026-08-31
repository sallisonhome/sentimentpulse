import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto py-24 px-6 text-center">
      <div
        className="text-xs uppercase tracking-widest"
        style={{ color: "var(--accent)" }}
      >
        404
      </div>
      <h1 className="mt-2 text-2xl font-semibold">Page not found</h1>
      <p className="mt-3 text-sm" style={{ color: "var(--text-muted)" }}>
        That title or page doesn't exist here.
      </p>
      <Link href="/">
        <a className="btn-primary mt-6">Back to dashboard</a>
      </Link>
    </div>
  );
}
