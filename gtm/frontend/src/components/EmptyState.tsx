import { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card p-10 flex flex-col items-center justify-center text-center">
      <div className="w-12 h-12 rounded-full bg-surface-elev border border-border flex items-center justify-center mb-4 text-dim">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      </div>
      <div className="text-base font-semibold text-ink mb-1">{title}</div>
      {description && <div className="text-sm text-muted max-w-md">{description}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted">
      <svg
        className="animate-spin text-accent"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <circle cx="12" cy="12" r="9" strokeOpacity="0.2" />
        <path d="M21 12a9 9 0 00-9-9" strokeLinecap="round" />
      </svg>
      {label && <span>{label}</span>}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="card border-red-500/30 bg-red-500/5 p-4 text-sm text-red-200">
      {message}
    </div>
  );
}
