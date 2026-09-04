import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

type Theme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "dark",
  toggleTheme: () => {},
});

/**
 * Shared with the rest of the Saber Suite via the `suite_theme` localStorage
 * key. SignalPulse, SentimentPulse, and this app all read/write the same key,
 * so a theme picked on any one app persists across the whole suite.
 *
 * Precedence when reading initial theme:
 *   1. localStorage.suite_theme (explicit user choice, shared)
 *   2. window.matchMedia('(prefers-color-scheme: dark)')
 *   3. default 'dark'
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("suite_theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      // localStorage disabled — fall through
    }
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "dark";
  });

  // Toggle html.light / html.dark. tokens.css uses these classes to override
  // the media-query fallback so an explicit user choice always wins.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme]);

  // Cross-tab sync: if the user toggles theme in SignalPulse in another tab
  // and comes back here, pick up the change automatically.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "suite_theme" && (e.newValue === "dark" || e.newValue === "light")) {
        setTheme(e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("suite_theme", next);
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
