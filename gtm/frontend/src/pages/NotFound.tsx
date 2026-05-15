import { Link } from "wouter";

export function NotFound() {
  return (
    <div className="card p-10 text-center">
      <div className="eyebrow mb-2">404</div>
      <h1 className="text-2xl font-bold mb-2">Page not found</h1>
      <p className="text-muted mb-6">That route doesn't exist in GTM Studio.</p>
      <Link href="/" className="btn-primary">
        Back to home
      </Link>
    </div>
  );
}
