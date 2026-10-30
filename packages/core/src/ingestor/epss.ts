/**
 * EPSS (Exploit Prediction Scoring System) fetcher — ADR 0039.
 *
 * Queries FIRST.org's free, no-auth EPSS API
 * (https://api.first.org/data/v1/epss) for the exploitability probability
 * (0–1) of CVE IDs harvested from fetched OSV advisories' `aliases` arrays,
 * and stamps the result onto `NewAdvisory.epssScore` — the field the impact
 * scorer has consumed since scoring_version 1.1.0 but which no pipeline
 * stage ever populated (every production row was null before this module).
 *
 * Deliberate shape decisions (per ADR 0039):
 *   - Batched: up to 100 CVE IDs per request via repeated comma-separated
 *     `cve=` values, chunks run with bounded concurrency. The API is a
 *     lookup service, not a bulk feed — chunking keeps each request small
 *     and the total request count proportional to advisory count, not
 *     package count.
 *   - Non-fatal: any chunk failure (network, HTTP, parse) warns and leaves
 *     those advisories' epssScore unset. Partial data beats no run — same
 *     discipline as changelog-signals.ts and downstream-dependents.ts.
 *   - Advisories with no CVE alias (GHSA-only, OSV-only) get no EPSS lookup
 *     and no warning: EPSS only covers CVEs, so absence of an alias is the
 *     expected case, not a data-quality problem (ADR 0039 rejected making
 *     EPSS mandatory for exactly this reason).
 *   - The API silently omits unknown CVE IDs from `data` (verified live);
 *     a missing entry means "no score available" and is not an error.
 *
 * ADR: docs/adr/0039-epss-integration.md
 */

import type { NewAdvisory } from "../db/schema.js";
import { DEFAULT_RETRY_DELAY_MS } from "./fetch-retry.js";
import { fetchJson } from "./fetch-json.js";
import { runBounded } from "./concurrency.js";

const EPSS_API_BASE = "https://api.first.org/data/v1/epss";

/** FIRST's documented batch size — 100 CVE IDs per request. */
const EPSS_BATCH_SIZE = 100;

/** Default number of in-flight EPSS batch requests at once. */
const DEFAULT_CONCURRENCY = 5;

/** Raw EPSS API response — only the fields this module reads. */
interface EpssApiResponse {
  status?: string;
  total?: number;
  data?: { cve?: string; epss?: string; percentile?: string }[];
}

export interface EpssFetchResult {
  /** Map: CVE ID → EPSS probability (0–1). Only successfully-scored CVEs. */
  scores: Map<string, number>;
  /** Data-quality / transport warnings for the run log. */
  warnings: string[];
}

/**
 * Collect the unique CVE IDs referenced by an advisory set's OSV `aliases`
 * arrays, in first-seen order. OSV stores aliases uppercase ("CVE-…"), and
 * EPSS keys on exactly that form — ids are returned as-found, not
 * normalized, so a nonconforming alias simply misses at the API (verified
 * live: unknown ids are omitted from the response, not errors).
 */
export function extractCveIds(advisories: Iterable<{ rawData?: unknown }>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const advisory of advisories) {
    const aliases = (advisory.rawData as { aliases?: unknown } | null)?.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias === "string" && alias.startsWith("CVE-") && !seen.has(alias)) {
        seen.add(alias);
        ids.push(alias);
      }
    }
  }
  return ids;
}

export class EpssFetcher {
  private readonly baseUrl: string;
  private readonly concurrency: number;
  private readonly retryDelayMs: number;

  constructor(
    baseUrl: string = EPSS_API_BASE,
    // Low default: the API is a courtesy lookup service (FIRST's own docs)
    // and chunk count is advisory-count/100 — even 2000 CVEs is 20 requests.
    concurrency: number = DEFAULT_CONCURRENCY,
    // Flat backoff for the single transient-failure retry (fetch-retry.ts).
    // Tests pass 0; production keeps the default.
    retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
  ) {
    this.baseUrl = baseUrl;
    this.concurrency = concurrency;
    this.retryDelayMs = retryDelayMs;
  }

  /**
   * Fetch EPSS probabilities for the given CVE IDs in batches of 100.
   * A failed batch warns and yields no scores for its CVEs — it never
   * throws and never fails other batches.
   */
  async fetchScores(cveIds: string[]): Promise<EpssFetchResult> {
    const warnings: string[] = [];
    const scores = new Map<string, number>();
    if (cveIds.length === 0) {
      return { scores, warnings };
    }

    const chunks: string[][] = [];
    for (let i = 0; i < cveIds.length; i += EPSS_BATCH_SIZE) {
      chunks.push(cveIds.slice(i, i + EPSS_BATCH_SIZE));
    }

    // CVE IDs are restricted to [A-Z0-9-], safe to pass raw in a query
    // string; encodeURIComponent would be a no-op — kept for defense at the
    // single URL-construction point.
    const results = await runBounded(chunks, this.concurrency, async (chunk) => {
      const url = `${this.baseUrl}?cve=${chunk.map((id) => encodeURIComponent(id)).join(",")}`;
      try {
        const response = await fetchJson<EpssApiResponse>(url, undefined, {
          fetchOptions: { retryDelayMs: this.retryDelayMs },
          errorPrefix: "EPSS API",
        });
        return { kind: "ok" as const, response };
      } catch (err) {
        return {
          kind: "fail" as const,
          error:
            `EPSS fetch failed for a batch of ${String(chunk.length)} CVE(s): ${String(err)}. ` +
            `Those advisories keep no EPSS score this run.`,
        };
      }
    });

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result === undefined) continue;
      if (result.kind === "fail") {
        warnings.push(result.error);
        continue;
      }
      const { response } = result;
      if (!Array.isArray(response.data)) {
        const chunk = chunks[i];
        warnings.push(
          `EPSS API returned no data array for a batch of ${String(chunk?.length ?? 0)} CVE(s) ` +
            `(status ${response.status ?? "unknown"}) — those advisories keep no EPSS score this run.`,
        );
        continue;
      }
      for (const entry of response.data) {
        if (typeof entry.cve !== "string" || typeof entry.epss !== "string") continue;
        const probability = Number.parseFloat(entry.epss);
        if (Number.isNaN(probability) || probability < 0 || probability > 1) {
          warnings.push(
            `EPSS API returned an unparseable probability for ${entry.cve}: "${entry.epss}" — skipped.`,
          );
          continue;
        }
        scores.set(entry.cve, probability);
      }
    }

    return { scores, warnings };
  }
}

/**
 * ADR 0039's Step 1: enrich freshly-fetched advisories with EPSS scores.
 * Harvests CVE aliases, batch-queries FIRST, and sets `epssScore` on the
 * advisory insert rows it was given (mutated in place — the map is the
 * caller's upsert payload). Returns accumulated warnings.
 *
 * Non-fatal by design: every failure mode (no aliases, transport failure,
 * unparseable response) leaves epssScore unset and the ingestion run
 * continues. This is the only place the pipeline touches EPSS, so all three
 * OsvFetcher callers (cron ingestion, CLI, integration tests) get it.
 */
export async function enrichAdvisoriesWithEpss(
  advisories: Map<string, NewAdvisory>,
  warnings: string[],
  fetcher: EpssFetcher = new EpssFetcher(),
): Promise<void> {
  const cveIds = extractCveIds([...advisories.values()]);
  if (cveIds.length === 0) return;

  const { scores, warnings: epssWarnings } = await fetcher.fetchScores(cveIds);
  warnings.push(...epssWarnings);

  let matched = 0;
  for (const advisory of advisories.values()) {
    const aliases = (advisory.rawData as { aliases?: unknown } | null)?.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      const score = scores.get(alias);
      if (score !== undefined) {
        advisory.epssScore = score;
        matched++;
        break; // one score per advisory — first matching CVE wins
      }
    }
  }

  if (scores.size > 0 && matched === 0) {
    warnings.push(
      `EPSS returned ${String(scores.size)} score(s) but none matched an advisory's CVE aliases — ` +
        `scores not applied.`,
    );
  }
}
