/**
 * Ecosystem detection — ordered probing (ADR 0022, Decision 1)
 *
 * Tries a list of EcosystemIngestors in order, returns the first one whose
 * result actually resolves a manifest. If none resolve, returns a combined
 * result carrying every attempt's warnings, so the reason nothing was found
 * stays fully visible rather than only showing the last thing tried.
 *
 * There is deliberately no repos.ecosystem column (see ADR 0022) — which
 * ecosystem a repo is gets decided fresh on every ingestion run by this
 * function, not stored as a fact about the repo itself. This is what makes
 * it possible: dependencies.ecosystem and advisories.ecosystem are already
 * per-row (ADR 0003's original design), and exactly one ingestor "wins" per
 * repo here, so every dependency/advisory written for one run shares one
 * ecosystem with no per-row ambiguity to resolve downstream.
 *
 * Explicit, accepted simplification: a repo with manifests for more than
 * one ecosystem at once (e.g. both a package.json and a pyproject.toml at
 * root) resolves to whichever ingestor is listed first — the caller
 * controls probing order by the order it passes ingestors in, not this
 * function. True multi-ecosystem-per-repo support (running every
 * applicable ingestor rather than stopping at the first match) is a real
 * follow-on, not in scope here.
 *
 * Shared by scripts/ingest.js and cli/analyze.ts so this logic exists
 * exactly once — mirrors npm-parse.ts/pypi-parse.ts's own "fetching and
 * parsing are separate, and parsing logic isn't duplicated per caller"
 * principle, one layer up.
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";

/**
 * Try each ingestor's parseDependencies(repoPath) in order. Returns the
 * first result with manifest_resolved: true. If none resolve, returns the
 * last attempt's result with every attempt's warnings combined (in probing
 * order), so a caller sees the full "here's everything we tried" picture
 * rather than just the final ingestor's own warnings.
 *
 * @param ingestors - tried in array order; the caller controls probing
 *   order by how it orders this list (ADR 0022: npm first, then PyPI).
 * @param repoPath - passed through to each ingestor unchanged — a GitHub
 *   raw content base URL for HTTP-based ingestors, or a local filesystem
 *   path for filesystem-based ones. Every ingestor passed in must accept
 *   the same kind of repoPath; the router itself has no opinion on which.
 */
export async function detectEcosystem(
  ingestors: EcosystemIngestor[],
  repoPath: string,
): Promise<IngestorResult> {
  const attempts: IngestorResult[] = [];

  for (const ingestor of ingestors) {
    const result = await ingestor.parseDependencies(repoPath);
    attempts.push(result);

    if (result.manifest_resolved) {
      return result;
    }
  }

  const last = attempts[attempts.length - 1];

  if (last === undefined) {
    // No ingestors were provided at all — a caller bug, not a real repo
    // outcome. Fails safe (empty, unresolved) rather than throwing, same
    // "never throw, report via warnings" contract every EcosystemIngestor
    // implementation already follows.
    return {
      ecosystem: "npm",
      dependencies: [],
      lock_file_present: false,
      manifest_resolved: false,
      warnings: ["detectEcosystem() was called with an empty ingestors list."],
    };
  }

  return {
    ...last,
    warnings: attempts.flatMap((attempt) => attempt.warnings),
  };
}
