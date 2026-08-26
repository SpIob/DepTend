/**
 * Repo-submission manifest pre-check (Roadmap Now #4, Option A)
 *
 * Runs the same GitHub-metadata-fetch + ordered-ecosystem-probing pipeline
 * the real ingestion run will use, but synchronously, at submission time —
 * before a repo is written to the DB at all. Without this, a repo with no
 * package.json/pyproject.toml/requirements.txt/go.mod at its root still
 * consumes a repo-cap slot on submission and only self-reports as
 * ingestionStatus: "skipped" once ingestion actually runs, sometime later
 * (ADR 0021). This closes that gap at the source: reject immediately,
 * before the row — and the cap slot — ever exist.
 *
 * Deliberately reuses fetchGitHubRepoMeta + detectEcosystem + the three
 * real HTTP ingestors rather than re-implementing manifest detection here.
 * "Does this repo have anything DepTend can analyze" should have exactly
 * one implementation — the one the real pipeline (scripts/ingest.js) and
 * the CLI (cli/src/analyze.ts) both already trust — not a third, separate
 * guess living in the submission route.
 *
 * Not a security boundary, and not exhaustive spam prevention — a
 * bad-faith submitter can still put a trivial, real manifest in a repo to
 * get past this. It targets one specific, common, non-adversarial failure
 * mode: submitting the wrong kind of repo (docs, a blog, a monorepo
 * subfolder, an empty scaffold) to a tool that only analyzes dependency
 * manifests.
 *
 * Costs one GitHub REST API call (fetchGitHubRepoMeta) plus whatever raw
 * content requests detectEcosystem's ordered probing makes — the same
 * calls the real ingestion run would make anyway, just moved earlier.
 * Bounded by the existing 5/hour-per-user submission rate limit (ADR
 * 0025), so this can't be hammered independently of that.
 */

import {
  buildRawContentBase,
  fetchGitHubRepoMeta,
  GitHubMetaError,
  type GitHubRepoMeta,
} from "./github-meta.js";
import { detectEcosystem } from "./detect.js";
import { NpmIngestor } from "./npm.js";
import { PyPIIngestor } from "./pypi.js";
import { GoIngestor } from "./go.js";
import type { Ecosystem } from "../db/schema.js";

export type ManifestCheckResult =
  | { ok: true; ecosystem: Ecosystem; meta: GitHubRepoMeta }
  | {
      ok: false;
      reason: "not_found" | "rate_limited" | "verification_failed" | "no_manifest";
      message: string;
    };

/**
 * Tighter transport policy than ingestion's defaults — this runs inside a
 * user-facing POST request, so a retry backoff or hung socket must not
 * stall it the way a 30 s default would. One quick retry, ten-second
 * deadline, then the route's existing 404/503 mapping takes over.
 *
 * maxRetryAfterMs matters as much as the deadline here: without it, a 403/
 * 429 carrying `Retry-After: 120` (the shared unauthenticated GitHub
 * budget's signature) would override the intent above and sleep ~2 minutes
 * inside the submitter's request — fetch-retry.ts honors server Retry-After
 * up to its own cap unless told otherwise (ADR 0037). Capped at the same
 * value as retryDelayMs: if the window is genuinely longer than that, the
 * retry fails fast and the route's 503 "try again later" is the honest
 * answer anyway.
 */
const REQUEST_CONTEXT_TRANSPORT = {
  retryDelayMs: 2_000,
  timeoutMs: 10_000,
  maxRetryAfterMs: 2_000,
} as const;

/**
 * @param token - passed straight through to fetchGitHubRepoMeta; null runs
 *   unauthenticated (60 req/hr, shared globally by IP — see the code
 *   comment on GH_READ_TOKEN in api/repos/route.ts for why this is null by
 *   default in /app today, not a token this function chose on its own).
 */
export async function checkSubmittableRepo(
  owner: string,
  name: string,
  token: string | null,
): Promise<ManifestCheckResult> {
  let meta: GitHubRepoMeta;
  try {
    meta = await fetchGitHubRepoMeta(owner, name, token, REQUEST_CONTEXT_TRANSPORT);
  } catch (err) {
    // fetchGitHubRepoMeta throws GitHubMetaError for exactly the two
    // branch-worthy failures (kind "not_found" | "rate_limited"); anything
    // else — network error, other non-OK status — is verification_failed.
    // Exhaustive on kind per the codebase's outcome-union convention.
    if (err instanceof GitHubMetaError) {
      switch (err.kind) {
        case "not_found":
          return { ok: false, reason: "not_found", message: err.message };
        case "rate_limited":
          return { ok: false, reason: "rate_limited", message: err.message };
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "verification_failed", message };
  }

  // Branch is repo-controlled and git permits `%` in refnames — encoded per
  // segment so a crafted refname can't redirect the probe's path (ADR 0037).
  const rawBase = buildRawContentBase(owner, name, meta.default_branch);
  const result = await detectEcosystem(
    [
      new NpmIngestor(REQUEST_CONTEXT_TRANSPORT),
      new PyPIIngestor(REQUEST_CONTEXT_TRANSPORT),
      new GoIngestor(REQUEST_CONTEXT_TRANSPORT),
    ],
    rawBase,
  );

  if (!result.manifest_resolved) {
    return {
      ok: false,
      reason: "no_manifest",
      message:
        "We couldn't find a package.json, pyproject.toml/requirements.txt, or go.mod at the repo root. " +
        "DepTend currently analyzes npm, PyPI, or Go projects only.",
    };
  }

  return { ok: true, ecosystem: result.ecosystem, meta };
}
