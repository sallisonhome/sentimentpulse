import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";

type DeckTheme = "dark" | "light";

type Ctx = {
  deckTheme: DeckTheme;
  setDeckTheme: (t: DeckTheme) => void;
  toggleDeckTheme: () => void;
};

const ThemeCtx = createContext<Ctx | null>(null);

export function DeckThemeProvider({ children }: { children: ReactNode }) {
  // Default deck theme is DARK to match the suite, but this only affects
  // the SLIDE preview/example — never the UI chrome.
  const [deckTheme, setDeckTheme] = useState<DeckTheme>("dark");
  const toggleDeckTheme = useCallback(
    () => setDeckTheme((t) => (t === "dark" ? "light" : "dark")),
    []
  );
  return (
    <ThemeCtx.Provider value={{ deckTheme, setDeckTheme, toggleDeckTheme }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export function useDeckTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error("useDeckTheme must be used inside DeckThemeProvider");
  return ctx;
}
