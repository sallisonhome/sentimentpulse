import { Link } from "wouter";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <header
        className="border-b flex items-center justify-between px-6 py-3"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center"
            style={{ background: "var(--accent-glow)", color: "var(--accent)" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-4 h-4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 00-3-3.87" />
              <path d="M16 3.13a4 4 0 010 7.75" />
            </svg>
          </div>
          <div className="flex flex-col">
            <div
              className="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: "var(--text-dim)" }}
            >
              Saber Intelligence Suite
            </div>
            <Link href="/">
              <a
                className="text-base font-semibold leading-tight"
                style={{ color: "var(--text)" }}
              >
                Publishing Partnerships
              </a>
            </Link>
          </div>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/">
            <a className="hover:text-white" style={{ color: "var(--text-muted)" }}>
              Dashboard
            </a>
          </Link>
          <a
            href="/"
            className="hover:text-white"
            style={{ color: "var(--text-muted)" }}
          >
            ← Suite home
          </a>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer
        className="border-t px-6 py-3 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
      >
        Saber Interactive · Publishing Partnerships · Confidential — Do Not Share
      </footer>
    </div>
  );
}
