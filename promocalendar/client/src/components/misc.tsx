import { Link } from "wouter";
import type { ReactNode } from "react";

export function Skeleton({ height = 80, count = 1 }: { height?: number; count?: number }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function ErrorBanner({ error }: { error: Error }) {
  return (
    <div className="empty" style={{ borderColor: "rgba(239,68,68,0.35)", color: "#fecaca" }}>
      <h3 style={{ color: "#fecaca" }}>Something went wrong</h3>
      <p>{error.message}</p>
    </div>
  );
}

export function EmptyNoUpload({ canUpload }: { canUpload: boolean }) {
  return (
    <div className="empty">
      <h3>No promo calendar loaded yet</h3>
      <p>
        {canUpload ? (
          <>Upload a Promo-Schedule workbook from the <Link href="/settings">Settings</Link> page to get started.</>
        ) : (
          <>Ask an authorized uploader (steve@saber3d.com) to add a Promo-Schedule sheet.</>
        )}
      </p>
    </div>
  );
}

export function SegToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "on" : ""}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({
  title,
  sub,
  right,
  children,
}: {
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="strip">
      <div className="section-h">
        <h2>{title}</h2>
        {right ? right : sub ? <span className="sub">{sub}</span> : null}
      </div>
      {children}
    </section>
  );
}
