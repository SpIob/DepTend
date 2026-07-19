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
 *   npx deptend <repo-path> --github-url <url> [--output <file>] [--json]
 *
 * Arguments:
 *   <repo-path>      Local path to the repo root (containing package.json).
 *
 * Options:
 *   --github-url     GitHub URL of the repo, e.g. https://github.com/owner/name.
 *                     Required — used to fetch stars/open issues, needed for
 *                     ecosystem_value scoring. A local checkout has no
 *                     reliable way to derive this on its own.
 *   --output <file>  Write the full JSON result to this file.
 *   --json           Print the full JSON result to stdout instead of the
 *                     human-readable summary (ignored if --output is given).
 *   --help, -h       Show this message.
 *
 * Environment variables:
 *   GITHUB_TOKEN     Optional but recommended — raises the GitHub API rate
 *                     limit from 60 to 5,000 requests/hour. Same variable
 *                     scripts/ingest.js uses.
 *
 * Exit codes:
 *   0  Analysis completed successfully.
 *   1  Invalid arguments, or the analysis failed.
 */

import { parseGithubUrl } from "@deptend/core/db/repos.js";
import { analyze } from "./analyze.js";
import { writeOutput } from "./output.js";

interface ParsedArgs {
  repoPath: string;
  githubUrl: string;
  outputPath: string | null;
  json: boolean;
}

const USAGE = `Usage: deptend <repo-path> --github-url <url> [--output <file>] [--json]

Arguments:
  <repo-path>      Local path to the repo root (containing package.json)

Options:
  --github-url     GitHub URL of the repo, e.g. https://github.com/owner/name (required)
  --output <file>  Write the full JSON result to this file
  --json           Print the full JSON result to stdout
  --help, -h       Show this message

Environment variables:
  GITHUB_TOKEN     Optional. Raises the GitHub API rate limit to 5,000 req/hr.`;

function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.includes("--help") || argv.includes("-h")) {
    return null;
  }

  let repoPath: string | undefined;
  let githubUrl: string | undefined;
  let outputPath: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--github-url") {
      githubUrl = argv[++i];
    } else if (arg === "--output") {
      outputPath = argv[++i] ?? null;
    } else if (arg === "--json") {
      json = true;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      repoPath ??= arg;
    } else {
      throw new Error(`Unrecognized argument: ${String(arg)}\n\n${USAGE}`);
    }
  }

  if (repoPath === undefined) {
    throw new Error(`Missing required <repo-path> argument.\n\n${USAGE}`);
  }
  if (githubUrl === undefined) {
    throw new Error(`Missing required --github-url flag.\n\n${USAGE}`);
  }

  return { repoPath, githubUrl, outputPath, json };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args === null) {
    console.log(USAGE);
    return;
  }

  const parsedUrl = parseGithubUrl(args.githubUrl);
  if (parsedUrl === null) {
    throw new Error(
      `--github-url "${args.githubUrl}" doesn't look like a valid GitHub repo URL. ` +
        `Expected something like https://github.com/owner/name.`,
    );
  }

  const githubToken = process.env.GITHUB_TOKEN ?? null;

  const result = await analyze({
    repoPath: args.repoPath,
    githubOwner: parsedUrl.owner,
    githubName: parsedUrl.name,
    githubToken,
  });

  await writeOutput(result, { outputPath: args.outputPath, json: args.json });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
