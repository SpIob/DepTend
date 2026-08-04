/**
 * GitHub repository reference parsing
 *
 * Shared by the npm, PyPI, and Go registry fetchers (Step 2) to resolve a
 * dependency's own upstream repo from whatever form each registry hands
 * back: npm's `repository` field (a string, or a {type, url} object, in
 * several URL/shorthand variants), a PyPI project_urls value, or a raw Go
 * module path. Everything funnels through one normalizer so "does this
 * resolve to a github.com repo" is answered exactly once, not three
 * slightly-different ways.
 *
 * Deliberately narrow: anything that doesn't resolve to a github.com host
 * returns null rather than guessing — non-GitHub sources (GitLab,
 * Bitbucket, self-hosted, no field at all) are a real, expected, honestly-
 * reported gap, not a bug. See ADR 0029, Decision 1.
 *
 * Pure, no I/O — this module only parses strings already obtained by the
 * registry fetchers.
 *
 * ADR: docs/adr/0029-breaking-change-signals.md
 */

/** A resolved GitHub repo — owner and repo name, nothing more. */
export interface SourceRepoRef {
  owner: string;
  name: string;
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * "owner/repo" with no scheme and no host — npm's bare-shorthand
 * `repository` form (e.g. "lodash/lodash"). Intentionally handled only
 * inside parseNpmRepositoryField(), not the shared parseSourceRepo() —
 * a bare "word/word" string is genuinely ambiguous without npm-field
 * context: a hostless Go module path like "gopkg.in/yaml.v3" has the
 * identical one-slash shape and would otherwise be misparsed as
 * {owner: "gopkg.in", name: "yaml.v3"} (confirmed by a failing test
 * during Step 1, not assumed). GitHub owners/orgs can't contain dots,
 * so restricting the owner segment here removes the false-positive for
 * the npm-specific case without needing any ecosystem context.
 */
const BARE_SHORTHAND_RE = /^[\w-]+\/[\w.-]+$/;

/** npm's "github:owner/repo" shorthand form. */
const GITHUB_SHORTHAND_RE = /^github:([\w.-]+)\/([\w.-]+?)\/?$/;

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

/** Only called from parseNpmRepositoryField() — see BARE_SHORTHAND_RE's comment. */
function tryBareShorthand(trimmed: string): SourceRepoRef | null {
  if (!BARE_SHORTHAND_RE.test(trimmed)) return null;
  const [owner, name] = trimmed.split("/");
  if (owner === undefined || name === undefined) return null;
  return { owner, name: stripGitSuffix(name) };
}

/** Drops a URL fragment/query if present — irrelevant to repo identity. */
function stripFragmentAndQuery(raw: string): string {
  const cutIndex = raw.search(/[#?]/);
  return cutIndex === -1 ? raw : raw.slice(0, cutIndex);
}

/**
 * Normalizes one raw repository reference into a {owner, name} pair, or
 * null if it isn't (or doesn't resolve to) a github.com repository.
 *
 * Handles, in order:
 *   - "github:owner/repo"                   (npm shorthand)
 *   - "git+https://github.com/owner/repo.git"
 *   - "git+ssh://git@github.com/owner/repo.git"
 *   - "git://github.com/owner/repo.git"
 *   - "https://github.com/owner/repo[.git][/]"
 *   - "github.com/owner/repo[/subpath...]"  (raw Go module path — extra
 *     path segments, e.g. a major-version suffix or subpackage, are
 *     dropped; only the first two segments identify the repo)
 *
 * Deliberately does NOT handle bare "owner/repo" shorthand (no scheme,
 * no host) — see BARE_SHORTHAND_RE's own comment for why that's scoped
 * to parseNpmRepositoryField() instead, where the npm-field context
 * resolves an otherwise-genuine ambiguity with hostless Go module paths.
 *
 * Also not handled: SSH shorthand ("git@github.com:owner/repo.git", no
 * "//") — rare enough in registry data that it's skipped rather than
 * hand-parsed; falls through to null like any other unresolvable form.
 */
export function parseSourceRepo(raw: string | null | undefined): SourceRepoRef | null {
  if (raw === null || raw === undefined) return null;

  const trimmed = stripFragmentAndQuery(raw.trim());
  if (trimmed === "") return null;

  const shorthandMatch = GITHUB_SHORTHAND_RE.exec(trimmed);
  if (shorthandMatch) {
    const [, owner, name] = shorthandMatch;
    if (owner !== undefined && name !== undefined) {
      return { owner, name: stripGitSuffix(name) };
    }
  }

  let urlCandidate = trimmed.replace(/^git\+/, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlCandidate)) {
    urlCandidate = `https://${urlCandidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlCandidate);
  } catch {
    return null;
  }

  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;

  const [owner, rawName] = segments;
  if (owner === undefined || rawName === undefined) return null;
  return { owner, name: stripGitSuffix(rawName) };
}

/**
 * npm's `repository` field is either a bare string or a {type, url}
 * object — this unwraps that shape and delegates to parseSourceRepo().
 * `type` is ignored: every real-world value observed is "git", and a
 * non-git VCS wouldn't resolve to a github.com host anyway.
 */
export function parseNpmRepositoryField(repository: unknown): SourceRepoRef | null {
  let raw: string | null = null;

  if (typeof repository === "string") {
    raw = repository;
  } else if (typeof repository === "object" && repository !== null && "url" in repository) {
    if (typeof repository.url === "string") raw = repository.url;
  }

  if (raw === null) return null;

  const trimmed = stripFragmentAndQuery(raw.trim());
  return tryBareShorthand(trimmed) ?? parseSourceRepo(raw);
}
