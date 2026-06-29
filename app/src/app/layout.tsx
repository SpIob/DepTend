import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "deptend.dev",
  description:
    "A maintenance-first dashboard that turns dependency data into prioritized, explainable maintenance missions.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
