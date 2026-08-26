import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";

// Canonical origin per ADR 0015 — deptend.vercel.app is the project's
// permanent domain; the in-app wordmark is the bare project name.
export const metadata: Metadata = {
  metadataBase: new URL("https://deptend.vercel.app"),
  title: {
    default: "DepTend",
    template: "%s — DepTend",
  },
  description:
    "A maintenance-first dashboard that turns dependency data into prioritized, explainable maintenance missions.",
  applicationName: "DepTend",
  openGraph: {
    type: "website",
    siteName: "DepTend",
    title: "DepTend",
    description:
      "A maintenance-first dashboard that turns dependency data into prioritized, explainable maintenance missions.",
  },
};

// Mobile-browser UI tint — the page background, not the accent, so the tint
// doesn't compete with accent-blue links and score numerals.
export const viewport: Viewport = {
  themeColor: "#F6F7F9",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="focus:bg-accent sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:px-3 focus:py-1.5 focus:font-mono focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
        <footer className="border-border border-t">
          <div className="text-ink-muted mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-6 font-mono text-xs sm:px-6">
            <span className="text-ink font-semibold">DepTend</span>
            <a
              href="https://github.com/SpIob/DepTend"
              className="hover:text-ink underline decoration-dotted underline-offset-2"
            >
              open source (MIT)
            </a>
            <span aria-hidden="true">·</span>
            <span>
              vulnerability data from{" "}
              <a
                href="https://osv.dev"
                className="hover:text-ink underline decoration-dotted underline-offset-2"
              >
                OSV.dev
              </a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
