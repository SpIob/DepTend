/**
 * Downstream-dependent counts via libraries.io
 *
 * Fetches how many packages depend on the *analyzed repo's* own published
 * package(s) — not a dependency's — to populate
 * EcosystemValueInputs.downstream_dependents, which has been null for
 * every mission since Phase 2 (ADR 0006). One paginated listing per
 * analyzed repo per run: GET /api/github/{owner}/{name}/projects returns
 * the repo's registry-linked projects, each carrying its own
 * dependents_count (1–5 paced requests depending on list length).
 *
 * Requires a free LIBRARIES_IO_API_KEY (account signup, no credit card) —
 * the third-party account ADR 0006 originally deferred and ADR 0032
 * accepted. Rate limit is 60 requests/minute per key, so calls are paced
 * client-side; at the current 150-repo cap a full run stays within
 * budget even when popular repos need multiple pages.
 *
 * Deliberately best-effort, never throws: no key configured, a repo
 * unknown to libraries.io, an empty project list, a rate-limited call
 * even after one backoff retry, or a network failure all just come back
 * as `count: null` — downstream_dependents stays null and
 * downstream_dependents_unavailable stays set (ADR 0006's
 * never-default-to-zero rule), exactly like the pre-ADR-0032 behavior.
 *
 * Distinguishing "checked, genuinely zero" from "couldn't check": only a
 * response containing at least one project yields a number. An app repo
 * that publishes nothing has no package to count dependents *of*, so an
 * empty list is unavailable, not zero — but a published library whose
 * linked project reports dependents_count 0 gets a real 0, flag cleared
 * ("checked, found nothing" is information, same philosophy as ADR 0029
 * Decision 4).
 *
 * ADR: docs/adr/0032-downstream-dependents.md
 */

const LIBRARIES_IO_API_BASE = "https://libraries.io/api";
const USER_AGENT = "deptend.dev/0.1.0 (https://github.com/deptend/deptend.dev)";

/** Client-side pacing floor — stays under the documented 60 req/min limit. */
const DEFAULT_MIN_INTERVAL_MS = 1_100;

/**
 * Page size / page cap for the projects listing (same bounds-and-cap
 * convention as changelog-signals.ts). Verified live against the real
 * endpoint: the default page size is 30 and popular repos link dozens of
 * junk packages whose metadata points at them — expressjs/express alone
 * links 76 — so small default pages silently truncate the list and lose
 * the real package entirely.
 */
const PER_PAGE = 100;
const MAX_PAGES = 5;

/** Wait before the single 429 retry when the response carries no usable Retry-After. */
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;

export interface RepoRef {
  owner: string;
  name: string;
}

export interface DownstreamDependentsResult {
  /**
   * Resolved dependent count (may be a genuine 0), or null when
   * unavailable — see the module docstring for which outcomes are which.
   */
  count: number | null;
  /** Non-fatal observations for the caller to log; empty on silent-null paths. */
  warnings: string[];
}

export interface FetchDownstreamDependentsOptions {
  /**
   * Pacing floor between consecutive calls in this process. Tests pass 0
   * to skip waiting; production keeps the default that respects 60 req/min.
   */
  minIntervalMs?: number;
  /** Backoff before the single 429 retry when Retry-After is absent/unusable. */
  rateLimitRetryDelayMs?: number;
}

interface LibrariesIoProjectShape {
  dependents_count?: unknown;
}

// ---------------------------------------------------------------------------
// Client-side pacing (module-level state — ingest.js drives repos
// sequentially through this process, so a single last-call timestamp is
// sufficient coordination)
// ---------------------------------------------------------------------------

let lastCallAt = 0;

/**
 * Clears module-level pacing state. Test-only — lets a test file start
 * each case from a cold clock instead of inheriting the previous case's
 * last-call timestamp (and its remaining wait).
 */
export function resetDownstreamDependentsPacing(): void {
  lastCallAt = 0;
}

async function pace(now: number, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const earliestAllowed = lastCallAt + minIntervalMs;
  if (now < earliestAllowed) {
    await new Promise((resolve) => setTimeout(resolve, earliestAllowed - now));
  }
  lastCallAt = Date.now();
}

function parseRetryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (header === null) return -1;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return -1;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
/**
 * Resolves the analyzed repo's downstream_dependents value. Never throws.
 *
 * Walks the paginated projects listing (up to MAX_PAGES × PER_PAGE) and
 * takes the max dependents_count seen. A scan that ends because the
 * listing ran out (< PER_PAGE items, or an empty next page) is complete
 * and its max is trustworthy; a scan that stops at the page cap with a
 * still-full last page is NOT — a truncated max would store a
 * misleadingly low number as real, checked data (flag cleared), so an
 * incomplete scan degrades to null + warning instead.
 *
 * Pacing state persists across calls within one process (the intended
 * production shape: sequential per-repo calls); tests that exercise the
 * real pacing default should advance fake timers or pass
 * `{ minIntervalMs: 0 }`.
 */
export async function fetchDownstreamDependents(
  repo: RepoRef,
  apiKey: string | null,
  options: FetchDownstreamDependentsOptions = {},
): Promise<DownstreamDependentsResult> {
  // No key configured — silently unavailable, zero network calls. The
  // caller warns once at startup rather than once per repo here.
  if (apiKey === null || apiKey === "") {
    return { count: null, warnings: [] };
  }

  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const rateLimitRetryDelayMs = options.rateLimitRetryDelayMs ?? DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;

  const baseUrl =
    `${LIBRARIES_IO_API_BASE}/github/${encodeURIComponent(repo.owner)}/` +
    `${encodeURIComponent(repo.name)}/projects?api_key=${encodeURIComponent(apiKey)}`;

  let maxCount: number | null = null;
  let scanComplete = false;

  for (let page = 1; page <= MAX_PAGES && !scanComplete; page++) {
    const pageResult = await fetchProjectsPage(
      `${baseUrl}&per_page=${String(PER_PAGE)}&page=${String(page)}`,
      minIntervalMs,
      rateLimitRetryDelayMs,
    );

    if (pageResult.kind === "not-found") {
      // Repo unknown to libraries.io — expected for unpublished/app
      // repos, so silent null, no warning noise across a full run.
      return { count: null, warnings: [] };
    }

    if (pageResult.kind === "http-error" || pageResult.kind === "network-error") {
      // Incomplete scan — a max over the pages seen so far could miss the
      // repo's real package (live-verified: expressjs/express's real
      // package sits behind dozens of junk links). Unavailable beats
      // wrong; the gathered pages are discarded.
      return {
        count: null,
        warnings: [describeFetchFailure(repo, pageResult)],
      };
    }

    if (pageResult.kind === "malformed") {
      return {
        count: null,
        warnings: [describeFetchFailure(repo, pageResult)],
      };
    }

    const projects = pageResult.projects;
    for (const raw of projects) {
      const project = raw as LibrariesIoProjectShape;
      if (typeof project.dependents_count !== "number") continue;
      if (!Number.isFinite(project.dependents_count)) continue;
      if (maxCount === null || project.dependents_count > maxCount) {
        maxCount = project.dependents_count;
      }
    }

    if (projects.length < PER_PAGE) {
      scanComplete = true;
    } else if (page === MAX_PAGES) {
      // Page cap hit with a full last page — the listing may continue.
      return {
        count: null,
        warnings: [
          `libraries.io project list for ${repo.owner}/${repo.name} exceeded ` +
            `${String(MAX_PAGES * PER_PAGE)} entries — scan incomplete, downstream_dependents left unavailable`,
        ],
      };
    }
  }

  if (maxCount === null) {
    // Complete scan, but no entry carried a usable count — no resolvable
    // published package, so unavailable rather than a fabricated 0.
    return { count: null, warnings: [] };
  }

  return { count: Math.max(0, Math.floor(maxCount)), warnings: [] };
}

// ---------------------------------------------------------------------------
// Single-page fetch (paced, retries a 429 once)
// ---------------------------------------------------------------------------

type PageResult =
  | { kind: "ok"; projects: unknown[] }
  | { kind: "not-found" }
  | { kind: "http-error"; status: number }
  | { kind: "network-error" }
  | { kind: "malformed"; reason: string };

async function fetchProjectsPage(
  url: string,
  minIntervalMs: number,
  rateLimitRetryDelayMs: number,
): Promise<PageResult> {
  let response: Response;
  try {
    await pace(Date.now(), minIntervalMs);
    response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response);
      const waitMs = retryAfterMs >= 0 ? retryAfterMs : rateLimitRetryDelayMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      await pace(Date.now(), minIntervalMs);
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    }
  } catch {
    return { kind: "network-error" };
  }

  if (response.status === 404) {
    return { kind: "not-found" };
  }

  if (!response.ok) {
    return { kind: "http-error", status: response.status };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "malformed", reason: "response was not valid JSON" };
  }

  if (!Array.isArray(body)) {
    return { kind: "malformed", reason: "response was not a project list" };
  }

  return { kind: "ok", projects: body };
}

function describeFetchFailure(repo: RepoRef, result: PageResult): string {
  const reason =
    result.kind === "http-error"
      ? `HTTP ${String(result.status)}`
      : result.kind === "network-error"
        ? "network error"
        : result.kind === "malformed"
          ? result.reason
          : "unexpected response";
  return `libraries.io request for ${repo.owner}/${repo.name} failed (${reason}) — downstream_dependents left unavailable`;
}
