import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#F6F7F9",
        surface: "#FFFFFF",
        border: "#E2E5EA",
        ink: {
          DEFAULT: "#12151C",
          muted: "#5B6472",
        },
        accent: "#2454E0",
        severity: {
          critical: "#B3261E",
          high: "#C46210",
          medium: "#9C7A05",
          low: "#3B6EA5",
          unknown: "#6B7280",
        },
      },
      fontFamily: {
        // Monospace-forward on purpose: this is a page about package names,
        // semver ranges, CVSS scores, and formulas — data that is already
        // monospace in the reader's mental model. System stacks only, no
        // network font fetch (next/font/google needs a Google Fonts
        // request at build time, which a zero-budget/local-first tool
        // shouldn't depend on to render).
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Cascadia Code",
          "Roboto Mono",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
