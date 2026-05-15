/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#0E1116",
        surface: "#161A21",
        "surface-elev": "#1A1F28",
        "surface-hover": "#1E2430",
        border: "#1F2530",
        "border-strong": "#2A3140",
        ink: "#E8E6E1",
        muted: "#8A8F99",
        dim: "#5E6470",
        accent: "#FFB454",
        "accent-glow": "rgba(255, 180, 84, 0.10)",
        "light-bg": "#FFFFFF",
        "light-surface": "#F7F7F5",
        "light-ink": "#1A1A1A",
        "light-muted": "#5C5C5C",
        "light-hair": "#E8E8E8",
        "light-accent": "#1F9B8E",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      borderRadius: {
        DEFAULT: "10px",
        lg: "14px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.3)",
        elev: "0 8px 24px rgba(0,0,0,0.35)",
      },
    },
  },
  plugins: [],
};
