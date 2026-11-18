/**
 * Route-tree consistency guard.
 *
 * Next.js requires identical slug names at every dynamic segment position
 * ("You cannot use different slug names for the same dynamic path"). The
 * violation class is invisible to colocated route tests (they invoke the
 * handler directly, never through Next's route table) AND to the production
 * build — it only throws at server start / first request, which is how the
 * 2026-11-18 badge endpoint took every /api/repos route down (issue #38)
 * while typecheck, the full test suite, and the build all stayed green.
 *
 * This test walks the real filesystem tree and fails fast in CI instead.
 */
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_DIR = dirname(fileURLToPath(import.meta.url));

function collectRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRouteFiles(full, acc);
    } else if (entry.name === "route.ts") {
      acc.push(full);
    }
  }
  return acc;
}

describe("api route tree", () => {
  it("uses consistent slug names at every dynamic segment position", () => {
    const routeFiles = collectRouteFiles(API_DIR);
    expect(routeFiles.length).toBeGreaterThan(0);

    // prefix (segments before this one, joined) -> slug name claimed there
    const slugByPrefix = new Map<string, string>();
    const conflicts: string[] = [];

    for (const file of routeFiles) {
      const rel = relative(API_DIR, dirname(file));
      const segments = rel.split(sep);
      const seen: string[] = [];
      for (const segment of segments) {
        if (/^\[\[?\.\.\.?[^\]]+\]\]?$|^\[[^\]]+\]$/.test(segment)) {
          const slug = segment.replace(/^\[+/, "").replace(/\]+$/, "");
          const prefix = seen.join("/");
          const existing = slugByPrefix.get(prefix);
          if (existing !== undefined && existing !== slug) {
            conflicts.push(`${prefix || "<root>"}: "${existing}" vs "${slug}" (${rel})`);
          } else {
            slugByPrefix.set(prefix, slug);
          }
        }
        seen.push(segment);
      }
    }

    expect(conflicts).toEqual([]);
  });
});
