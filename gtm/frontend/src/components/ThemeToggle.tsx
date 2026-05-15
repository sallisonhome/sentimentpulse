import { useDeckTheme } from "../lib/theme";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { deckTheme, toggleDeckTheme } = useDeckTheme();
  const isDark = deckTheme === "dark";
  return (
    <button
      onClick={toggleDeckTheme}
      className="btn-secondary"
      title="Toggle deck theme (does not change UI chrome)"
      data-testid="button-deck-theme"
    >
      <span className="text-[11px] uppercase tracking-wider text-dim">
        Deck
      </span>
      <span
        className={`inline-flex items-center gap-1 ${
          isDark ? "text-ink" : "text-accent"
        }`}
      >
        {isDark ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
            Dark
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
            Light
          </>
        )}
      </span>
    </button>
  );
}
