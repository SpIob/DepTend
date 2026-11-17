#!/usr/bin/env node
/**
 * deptend CLI
 *
 * npx-runnable companion to the deptend.dev dashboard: produces the same
 * ranked, explainable mission list from a local repo path, entirely
 * in-memory — no DB, no hosted server dependency (per the project's
 * local-first goal).
 *
 * Usage:
 *   npx deptend <repo-path> [--github-url <url>] [--output <file>] [--json]
 *                          [--format human|json|sarif|markdown]
 *                          [--fail-on <level>] [--fail-on-count <n>]
 *                          [--baseline <file>] [--fail-on-new]
 *
 * Arguments:
 *   <repo-path>      Local path to the repo root (containing package.json).
 *
 * Options:
 *   --github-url     GitHub URL of the repo, e.g. https://github.com/owner/name.
 *                     Optional when <repo-path> is a git clone with an origin/upstream
 *                     remote — auto-detected via `git remote get-url`. Explicit flag
 *                     always wins. A local checkout alone can't derive stars/issues
 *                     for ecosystem_value scoring.
 *   --output <file>  Write the full JSON result to this file.
 *   --json           Print the full JSON result to stdout instead of the
 *                     human-readable summary (ignored if --output is given).
 *   --format <fmt>   Output format: human (default), json, sarif, markdown.
 *                     --json and --output keep working for back-compat.
 *   --fail-on <level>    Exit 1 if any mission severity >= level.
 *                         Levels: critical, high, medium, low, any (default: none).
 *   --fail-on-count <n>  Exit 1 if number of missions >= n (default: none).
 *                         Combines with --fail-on as OR (either tripping fails).
 *   --baseline <file>    Compare against previous --output JSON file.
 *                         Adds diff section to human output; adds diff object to JSON.
 *   --fail-on-new        Exit 1 if any missions are added vs baseline (requires --baseline).
 *   --help, -h       Show this message.
 *
 * Environment variables:
 *   GITHUB_TOKEN     Optional but recommended — raises the GitHub API rate
 *                     limit from 60 to 5,000 requests/hour. CI pipelines may
 *                     also set GH_INGEST_TOKEN (used by the scheduled ingestion).
 *
 * Exit codes:
 *   0  Analysis completed successfully (no threshold tripped).
 *   1  Threshold tripped (--fail-on, --fail-on-count, or --fail-on-new condition met).
 *   2  Operational error (invalid args, network failure, no manifest, etc.).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGithubUrl } from "@deptend/core/pipeline/parse-github-url.js";
import { analyze } from "./analyze.js";
import { writeOutput, type OutputFormat } from "./output.js";
import { parseBaselineFile, computeBaselineDiff, type BaselineDiff } from "./baseline.js";
import type { AnalyzeResult } from "./types.js";

type FailOnLevel = "critical" | "high" | "medium" | "low" | "any" | null;

interface ParsedArgs {
  repoPath: string;
  githubUrl: string | null;
  outputPath: string | null;
  json: boolean;
  format: OutputFormat;
  failOn: FailOnLevel;
  failOnCount: number | null;
  baselinePath: string | null;
  failOnNew: boolean;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  any: 0,
};

const FORMAT_OPTIONS: OutputFormat[] = ["human", "json", "sarif", "markdown"];

const USAGE = `Usage: deptend <repo-path> [--github-url <url>] [--output <file>] [--json] [--format <fmt>] [--fail-on <level>] [--fail-on-count <n>] [--baseline <file>] [--fail-on-new]

Arguments:
  <repo-path>      Local path to the repo root (containing package.json)

Options:
  --github-url         GitHub URL of the repo, e.g. https://github.com/owner/name (optional if repo has origin/upstream remote)
  --output <file>      Write the formatted output to this file
  --json               Print the full JSON result to stdout (back-compat, ignored if --output is set)
  --format <fmt>       Output format: human (default), json, sarif, markdown
  --fail-on <level>    Exit 1 if any mission severity >= level (critical|high|medium|low|any)
  --fail-on-count <n>  Exit 1 if number of missions >= n (OR with --fail-on)
  --baseline <file>    Compare against previous --output JSON file
  --fail-on-new        Exit 1 if any missions added vs baseline (requires --baseline)
  --help, -h           Show this message

Environment variables:
  GITHUB_TOKEN         Optional. Raises the GitHub API rate limit to 5,000 req/hr.`;

export function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.includes("--help") || argv.includes("-h")) {
    return null;
  }

  let repoPath: string | undefined;
  let githubUrl: string | null = null;
  let outputPath: string | null = null;
  let format: OutputFormat = "human";
  let failOn: FailOnLevel = null;
  let failOnCount: number | null = null;
  let baselinePath: string | null = null;
  let failOnNew = false;
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--github-url") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`--github-url requires a URL argument.\n\n${USAGE}`);
      }
      githubUrl = next;
    } else if (arg === "--output") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`--output requires a file path argument.\n\n${USAGE}`);
      }
      outputPath = next;
    } else if (arg === "--json") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
    } else if (arg === "--format") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(
          `--format requires a format argument (human|json|sarif|markdown).\n\n${USAGE}`,
        );
      }
      if (!FORMAT_OPTIONS.includes(next as OutputFormat)) {
        throw new Error(
          `Invalid --format: ${next}. Expected: human|json|sarif|markdown.\n\n${USAGE}`,
        );
      }
      format = next as OutputFormat;
    } else if (arg === "--fail-on") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(
          `--fail-on requires a level argument (critical|high|medium|low|any).\n\n${USAGE}`,
        );
      }
      if (!Object.keys(SEVERITY_RANK).includes(next)) {
        throw new Error(
          `Invalid --fail-on level: ${next}. Expected: critical|high|medium|low|any.\n\n${USAGE}`,
        );
      }
      failOn = next as FailOnLevel;
    } else if (arg === "--fail-on-count") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
      const next = argv[++i];
      if (next === undefined) {
        throw new Error(`--fail-on-count requires a number argument.\n\n${USAGE}`);
      }
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw new Error(`--fail-on-count requires a non-negative integer.\n\n${USAGE}`);
      }
      failOnCount = parsed;
    } else if (arg === "--baseline") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`--baseline requires a file path argument.\n\n${USAGE}`);
      }
      baselinePath = next;
    } else if (arg === "--fail-on-new") {
      if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}\n\n${USAGE}`);
      seen.add(arg);
      failOnNew = true;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      repoPath ??= arg;
    } else {
      throw new Error(`Unrecognized argument: ${String(arg)}\n\n${USAGE}`);
    }
  }

  // Default --json to false, not undefined, so the field has a stable type.
  const json = seen.has("--json");

  if (repoPath === undefined) {
    throw new Error(`Missing required <repo-path> argument.\n\n${USAGE}`);
  }

  if (failOnNew && baselinePath === null) {
    throw new Error(`--fail-on-new requires --baseline to be set.\n\n${USAGE}`);
  }

  return {
    repoPath,
    githubUrl,
    outputPath,
    json,
    format,
    failOn,
    failOnCount,
    baselinePath,
    failOnNew,
  };
}

/**
 * Attempts to auto-detect the GitHub URL from the repo's git remotes.
 * Tries 'origin' first, then 'upstream'. Returns null if not a git repo,
 * no remotes, or the remote URL is not a parseable GitHub URL.
 */
function detectGithubUrlFromGit(repoPath: string): { url: string; remote: string } | null {
  for (const remote of ["origin", "upstream"]) {
    try {
      const remoteUrl = execFileSync("git", ["remote", "get-url", remote], {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (remoteUrl) {
        const parsed = parseGithubUrl(remoteUrl);
        if (parsed !== null) {
          return { url: parsed.githubUrl, remote };
        }
      }
    } catch {
      // git command failed (not a repo, no such remote, etc.) — try next
    }
  }
  return null;
}

/**
 * Checks if the analysis result trips any --fail-on thresholds.
 * Returns a summary string if tripped, null otherwise.
 */
export function checkFailOnThresholds(
  result: AnalyzeResult,
  failOn: FailOnLevel,
  failOnCount: number | null,
): string | null {
  const reasons: string[] = [];

  // Check --fail-on severity threshold
  if (failOn !== null) {
    const thresholdRank = SEVERITY_RANK[failOn] ?? 0;
    for (const mission of result.missions) {
      const missionSeverity = mission.advisory.severity.toLowerCase();
      const missionRank = SEVERITY_RANK[missionSeverity] ?? 0;
      if (missionRank >= thresholdRank) {
        reasons.push(
          `${mission.advisory.osv_id} (${mission.advisory.severity}, score ${mission.composite_score.toFixed(1)})`,
        );
      }
    }
  }

  // Check --fail-on-count threshold
  if (failOnCount !== null && result.missions.length >= failOnCount) {
    if (failOn === null || reasons.length === 0) {
      // Count-only trip: list all missions
      for (const mission of result.missions) {
        reasons.push(
          `${mission.advisory.osv_id} (${mission.advisory.severity}, score ${mission.composite_score.toFixed(1)})`,
        );
      }
    }
    // If failOn also tripped, reasons already contains the offending missions
  }

  if (reasons.length === 0) {
    return null;
  }

  return `Threshold tripped: ${reasons.join("; ")}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args === null) {
    console.log(USAGE);
    return 0;
  }

  let githubUrl = args.githubUrl;
  if (githubUrl === null) {
    const detected = detectGithubUrlFromGit(args.repoPath);
    if (detected !== null) {
      githubUrl = detected.url;
      console.error(`Using ${githubUrl} from ${detected.remote} remote`);
    } else {
      throw new Error(
        `Missing required --github-url flag (auto-detection failed: not a git repo, no origin/upstream remote, or remote URL is not a GitHub URL).\n\n${USAGE}`,
      );
    }
  }

  const parsedUrl = parseGithubUrl(githubUrl);
  if (parsedUrl === null) {
    throw new Error(
      `--github-url "${githubUrl}" doesn't look like a valid GitHub repo URL. ` +
        `Expected something like https://github.com/owner/name.`,
    );
  }

  const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_INGEST_TOKEN ?? null;
  if (githubToken === null) {
    console.warn(
      "GITHUB_TOKEN is not set. GitHub API calls will be unauthenticated " +
        "(60 req/hr limit). Set GITHUB_TOKEN (or GH_INGEST_TOKEN in CI) to raise the limit to 5,000 req/hr.",
    );
  }

  const result = await analyze({
    repoPath: args.repoPath,
    githubOwner: parsedUrl.owner,
    githubName: parsedUrl.name,
    githubToken,
  });

  // Check fail-on thresholds before writing output (so JSON output still works)
  const failSummary = checkFailOnThresholds(result, args.failOn, args.failOnCount);

  // Handle baseline diff
  let diff: BaselineDiff | null = null;
  if (args.baselinePath !== null) {
    const baselineContent = readFileSync(args.baselinePath, "utf-8");
    const baseline = parseBaselineFile(baselineContent);
    if (baseline === null) {
      throw new Error(
        `Malformed baseline file: ${args.baselinePath}. Expected a valid --output JSON file.`,
      );
    }
    diff = computeBaselineDiff(result, baseline);
  }

  // Check --fail-on-new
  let failOnNewSummary: string | null = null;
  if (args.failOnNew && diff !== null && diff.added.length > 0) {
    const reasons = diff.added.map(
      (m) => `${m.advisory.osv_id} (${m.advisory.severity}, score ${m.composite_score.toFixed(1)})`,
    );
    failOnNewSummary = `New missions vs baseline: ${reasons.join("; ")}`;
  }

  await writeOutput(result, {
    outputPath: args.outputPath,
    json: args.json,
    format: args.format,
    ...(diff !== null && { diff }),
  });

  // Print diff summary for human format
  if (diff !== null && args.format === "human") {
    console.error(""); // Separate from main output
    console.error(formatDiffSummary(diff));
  }

  // Exit code logic: fail-on-new takes precedence over other fail-on flags
  if (failOnNewSummary !== null) {
    console.error(failOnNewSummary);
    return 1;
  }

  if (failSummary !== null) {
    console.error(failSummary);
    return 1;
  }

  return 0;
}

/**
 * Generates a human-readable diff summary for console output.
 */
function formatDiffSummary(diff: BaselineDiff): string {
  const lines: string[] = [];

  if (diff.added.length === 0 && diff.resolved.length === 0) {
    lines.push("No changes since baseline.");
    return lines.join("\n");
  }

  lines.push("## Diff vs Baseline");
  lines.push("");

  if (diff.added.length > 0) {
    lines.push(`### ➕ Added (${diff.added.length})`);
    lines.push("");
    for (const mission of diff.added) {
      const severity = mission.advisory.severity.toUpperCase();
      const score = mission.composite_score.toFixed(1);
      const osvShort =
        mission.advisory.osv_id.length > 8
          ? mission.advisory.osv_id.slice(0, 8)
          : mission.advisory.osv_id;
      lines.push(`- [${severity}] ${score} — ${mission.dependency.package_name} (${osvShort})`);
    }
    lines.push("");
  }

  if (diff.resolved.length > 0) {
    lines.push(`### ✅ Resolved (${diff.resolved.length})`);
    lines.push("");
    for (const mission of diff.resolved) {
      const severity = mission.advisory.severity.toUpperCase();
      const osvShort =
        mission.advisory.osv_id.length > 8
          ? mission.advisory.osv_id.slice(0, 8)
          : mission.advisory.osv_id;
      lines.push(`- [${severity}] ${mission.dependency.package_name} (${osvShort})`);
    }
    lines.push("");
  }

  if (diff.unchanged.length > 0) {
    lines.push(`### ➡️ Unchanged (${diff.unchanged.length})`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * True when this module is the process entry point (i.e. invoked via
 * `node dist/index.js` / the `deptend` bin), false when imported for testing.
 * Same gate pattern scripts/ingest.js uses for its exportable ingestRepo()
 * (AGENTS.md §13).
 *
 * Both sides are realpath-resolved before comparison, and that is load-bearing.
 * An installed package is reached through a `node_modules/.bin/deptend` symlink,
 * so `process.argv[1]` is the symlink path while `import.meta.url` is the real
 * file behind it. Comparing them unresolved makes this gate false under the
 * package's normal invocation, and the CLI then exits 0 having printed nothing —
 * the silent no-op that shipped in 0.1.0 and was fixed in 0.1.1 (ADR 0067).
 * A path that cannot be resolved is not the entry point.
 */
export function isEntryPoint(entryPath: string | undefined, moduleUrl: string): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(2);
    });
}
