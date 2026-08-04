/**
 * Breaking-change / migration-guide signals via GitHub Releases
 *
 * Fetches a *dependency's own* upstream GitHub repo's Releases — not the
 * analyzed repo's — to populate EffortInputs.has_migration_guide and
 * .breaking_change_signals, which have been hardcoded false/[] since Phase
 * 2 (ADR 0007 §5). Reuses the same GITHUB_TOKEN / auth pattern
 * github-meta.ts already established; no new secret, no new account.
 *
 * Deliberately best-effort, never throws: a dependency with no resolvable
 * GitHub repo, no Releases at all, a rate-limited call, or a network
 * failure all just come back as `source_available: false` — a real,
 * expected outcome (especially for PyPI, per ADR 0029 Decision 1), not a
 * fatal error for the whole ingestion run.
 *
 * Deliberately takes already-resolved plain version strings
 * (`currentFloor`/`targetVersion`), not a version *range* — computing a
 * "current version" proxy from a declared range is a scoring concern
 * (mission-scorer.ts's inferSemverBump/extractPep440Floor already do it
 * for the semver_bump label) and this module has no reason to duplicate
 * that or import across the ingestor/scorer boundary, which nothing in
 * this codebase does today in either direction. The caller (writer.ts,
 * which already imports mission-scorer.ts) resolves the floor once and
 * passes it in.
 *
 * ADR: docs/adr/0029-breaking-change-signals.md
 */

import semver from "semver";
import { compare as pep440Compare, valid as pep440Valid } from "@renovatebot/pep440";
import type { Ecosystem } from "../db/schema.js";
import type { SourceRepoRef } from "./source-repo.js";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "deptend.dev/0.1.0 (https://github.com/deptend/deptend.dev)";

/** Newest-first pages of up to 100 releases each — bounds worst-case calls per dependency. */
const MAX_PAGES = 5;
const PER_PAGE = 100;

const MAX_BREAKING_CHANGE_SIGNALS = 5;
const MAX_SIGNAL_LENGTH = 200;

export interface EffortSignals {
  has_migration_guide: boolean;
  breaking_change_signals: string[];
  /** false = no resolvable repo, no reachable Releases data, or the fetch failed/was rate-limited. */
  source_available: boolean;
}

export const UNAVAILABLE_SIGNALS: Readonly<EffortSignals> = Object.freeze({
  has_migration_guide: false,
  breaking_change_signals: [],
  source_available: false,
});

// ---------------------------------------------------------------------------
// Per-ecosystem version parsing/comparison (release-tag matching only —
// NOT the semver_bump inference mission-scorer.ts owns; see module docstring)
// ---------------------------------------------------------------------------

/**
 * Normalizes a release tag ("v1.2.3", "1.2.3") into a comparable version
 * string for the given ecosystem, or null if it doesn't parse — an
 * unparseable tag (a codename, "nightly", a non-version tag some repos
 * use for non-release tags) is skipped rather than guessed at.
 */
function parseReleaseTag(ecosystem: Ecosystem, tag: string): string | null {
  const candidate = tag.trim().replace(/^[vV](?=\d)/, "");
  if (ecosystem === "pypi") {
    return pep440Valid(candidate);
  }
  return semver.valid(candidate);
}

function compareVersions(ecosystem: Ecosystem, a: string, b: string): number {
  return ecosystem === "pypi" ? pep440Compare(a, b) : semver.compare(a, b);
}

// ---------------------------------------------------------------------------
// Signal extraction — pattern-level, not exhaustive (implementation detail
// per ADR 0029 Decision 3, not a sign-off point)
// ---------------------------------------------------------------------------

const MIGRATION_GUIDE_PATTERNS: RegExp[] = [
  /migrat(?:ion|ing)[\s-]*guide/i,
  /upgrad(?:e|ing)[\s-]*guide/i,
  /\bUPGRADING(?:\.md)?\b/,
  /^#{1,6}\s*migrat(?:ion|ing)\b/im,
];

function mentionsMigrationGuide(body: string): boolean {
  return MIGRATION_GUIDE_PATTERNS.some((pattern) => pattern.test(body));
}

const BREAKING_HEADING_RE = /^#{1,6}\s*(?:\u26a0\ufe0f?\s*)?breaking[\s-]?changes?\b/i;
const ANY_HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^[-*+]\s+(.+)$/;
const INLINE_BREAKING_RE = /^(?:[-*+]\s+)?(?:\u26a0\ufe0f?\s*)?breaking[\s-]?changes?\s*:\s*(.+)$/i;

function truncateSignal(text: string): string {
  return text.length <= MAX_SIGNAL_LENGTH ? text : `${text.slice(0, MAX_SIGNAL_LENGTH - 1)}…`;
}

/**
 * Extracts breaking-change lines from one release body, appending onto
 * `into` (shared across all releases in range for a single fetch, so the
 * cap applies per-dependency, not per-release). Two independent patterns:
 *   1. A "### Breaking Changes" heading — every line until the next
 *      heading is collected (bulleted or plain prose).
 *   2. A standalone "BREAKING CHANGE: ..." line anywhere else (the
 *      conventional-commits convention), even outside such a heading.
 */
function collectBreakingChangeSignals(body: string, into: string[]): void {
  const lines = body.split(/\r?\n/);
  let inBreakingSection = false;

  for (const rawLine of lines) {
    if (into.length >= MAX_BREAKING_CHANGE_SIGNALS) return;

    const line = rawLine.trim();
    if (line === "") continue;

    if (BREAKING_HEADING_RE.test(line)) {
      inBreakingSection = true;
      continue;
    }
    if (inBreakingSection && ANY_HEADING_RE.test(line)) {
      inBreakingSection = false;
    }

    if (inBreakingSection) {
      const bulletMatch = BULLET_RE.exec(line);
      const text = bulletMatch?.[1] ?? line;
      into.push(truncateSignal(text.trim()));
      continue;
    }

    const inlineMatch = INLINE_BREAKING_RE.exec(line);
    if (inlineMatch?.[1] !== undefined) {
      into.push(truncateSignal(inlineMatch[1].trim()));
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub Releases fetch
// ---------------------------------------------------------------------------

interface GitHubReleaseApiShape {
  tag_name?: unknown;
  body?: unknown;
  prerelease?: unknown;
  draft?: unknown;
}

function buildHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Fetches and scans a single dependency's upstream repo Releases for
 * breaking-change / migration-guide signals between `currentFloor`
 * (exclusive) and `targetVersion` (inclusive). Never throws.
 *
 * `currentFloor === null` means "no known lower bound" — every release at
 * or below targetVersion is in range, bounded only by MAX_PAGES.
 */
export async function fetchReleaseSignals(
  repo: SourceRepoRef,
  ecosystem: Ecosystem,
  currentFloor: string | null,
  targetVersion: string | null,
  token: string | null,
): Promise<EffortSignals> {
  if (targetVersion === null) {
    // Nothing to bound the range against — genuinely unavailable, not a
    // fetch failure (mirrors buildEffortInputs' own semver_bump "unknown"
    // treatment for a null target).
    return { ...UNAVAILABLE_SIGNALS };
  }

  const parsedTarget = parseReleaseTag(ecosystem, targetVersion);
  if (parsedTarget === null) {
    return { ...UNAVAILABLE_SIGNALS };
  }
  const parsedFloor = currentFloor === null ? null : parseReleaseTag(ecosystem, currentFloor);

  const headers = buildHeaders(token);
  let hasMigrationGuide = false;
  const breakingChangeSignals: string[] = [];
  let receivedAnyPage = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}` +
      `/releases?per_page=${String(PER_PAGE)}&page=${String(page)}`;

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch {
      // Network failure mid-run — return whatever was gathered so far
      // rather than discarding it; partial real data beats none.
      break;
    }

    if (response.status === 404) {
      // Resolved repo doesn't exist, or has no public Releases feature
      // enabled — a real, expected outcome, not a bug.
      return { ...UNAVAILABLE_SIGNALS };
    }

    if (response.status === 403 || response.status === 429) {
      // Rate-limited — same treatment as a network failure: keep whatever
      // was gathered so far, don't fail the whole ingestion run over one
      // dependency's changelog.
      break;
    }

    if (!response.ok) {
      break;
    }

    let releases: unknown;
    try {
      releases = await response.json();
    } catch {
      break;
    }

    if (!Array.isArray(releases)) {
      break; // malformed response — not a successful check
    }
    receivedAnyPage = true;
    if (releases.length === 0) {
      break; // repo has no (more) releases — a genuine, checked answer
    }

    let reachedFloor = false;

    for (const raw of releases) {
      const release = raw as GitHubReleaseApiShape;
      if (typeof release.tag_name !== "string") continue;
      if (release.prerelease === true || release.draft === true) continue;

      const parsedTag = parseReleaseTag(ecosystem, release.tag_name);
      if (parsedTag === null) continue;

      if (compareVersions(ecosystem, parsedTag, parsedTarget) > 0) {
        continue; // newer than the fix — not relevant to this upgrade
      }

      if (parsedFloor !== null && compareVersions(ecosystem, parsedTag, parsedFloor) <= 0) {
        // Releases page newest-first — everything remaining is even older.
        reachedFloor = true;
        break;
      }

      const body = typeof release.body === "string" ? release.body : "";
      if (!hasMigrationGuide && mentionsMigrationGuide(body)) hasMigrationGuide = true;
      collectBreakingChangeSignals(body, breakingChangeSignals);
    }

    if (reachedFloor) break;
  }

  return {
    has_migration_guide: hasMigrationGuide,
    breaking_change_signals: breakingChangeSignals,
    // Distinguishes "checked, found nothing in range" from "couldn't
    // check at all" (network failure, rate limit, or a response that
    // never parsed) — both leave has_migration_guide/breaking_change_
    // signals at their defaults, but only the latter should keep the
    // confidence flag set (ADR 0029 Decision 4).
    source_available: receivedAnyPage,
  };
}

// ---------------------------------------------------------------------------
// Batch prefetch, bounded concurrency (mirrors registry.ts's own pattern)
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;

export interface EffortSignalRequest {
  /** Caller-chosen key this result is stored under — opaque to this module. */
  key: string;
  sourceRepo: SourceRepoRef | null;
  ecosystem: Ecosystem;
  currentFloor: string | null;
  targetVersion: string | null;
}

/**
 * Resolves EffortSignals for a batch of requests, deduplicated by `key`
 * (two advisories on the same dependency with the same target version
 * would otherwise fetch the same upstream repo twice) and run with at
 * most `concurrency` fetches in flight. Requests with no resolvable
 * sourceRepo are resolved to UNAVAILABLE_SIGNALS with zero network calls —
 * added GitHub API load stays proportional to dependencies that actually
 * resolved a repo, not to every candidate (ADR 0029 Decision 2).
 */
export async function prefetchEffortSignals(
  requests: EffortSignalRequest[],
  token: string | null,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<Map<string, EffortSignals>> {
  const uniqueByKey = new Map<string, EffortSignalRequest>();
  for (const request of requests) {
    uniqueByKey.set(request.key, request);
  }
  const unique = Array.from(uniqueByKey.values());

  const results = new Map<string, EffortSignals>();
  let index = 0;

  async function worker(): Promise<void> {
    while (index < unique.length) {
      const current = index++;
      const request = unique[current];
      if (request === undefined) continue;

      if (request.sourceRepo === null) {
        results.set(request.key, { ...UNAVAILABLE_SIGNALS });
        continue;
      }

      const signals = await fetchReleaseSignals(
        request.sourceRepo,
        request.ecosystem,
        request.currentFloor,
        request.targetVersion,
        token,
      );
      results.set(request.key, signals);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
