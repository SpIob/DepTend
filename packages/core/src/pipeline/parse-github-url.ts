/**
 * GitHub URL parsing — shared pipeline module
 *
 * The implementation lives here, not in db/repos.ts. parseGithubUrl is pure
 * string handling with no database dependency, but it used to sit in
 * db/repos.ts, which imports drizzle-orm. This module was previously a
 * re-export shim over that function, and ESM re-exports are transitive module
 * loads — so every consumer of the shim, the CLI included, pulled the entire
 * ORM into its module graph just to parse a URL. Living in the pipeline layer
 * means importing the parser can no longer reach the data layer at all
 * (ADR 0066).
 *
 * Consumers import this path (`@deptend/core/pipeline/parse-github-url.js`):
 * cli/src/index.ts, scripts/ingest.js, scripts/integration.test.js, and
 * app/src/app/api/repos/route.ts.
 */

const GITHUB_URL_PATTERN =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * Parses and normalizes a submitted GitHub repo URL. Accepts with or
 * without protocol/www/trailing slash/.git suffix. Returns null for
 * anything that isn't a plausible github.com owner/repo URL — including
 * non-GitHub hosts, which is intentional (only public repos may be
 * ingested — see project plan §6.4 data & privacy).
 */
export function parseGithubUrl(
  input: string,
): { githubUrl: string; owner: string; name: string } | null {
  const match = GITHUB_URL_PATTERN.exec(input.trim());
  if (match === null) {
    return null;
  }
  const [, owner, name] = match;
  if (owner === undefined || name === undefined) {
    return null;
  }
  return { githubUrl: `https://github.com/${owner}/${name}`, owner, name };
}
