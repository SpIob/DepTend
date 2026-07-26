/**
 * go.mod parsing — pure, no I/O
 *
 * Interprets already-obtained go.mod content (raw text, or null if none was
 * found) into an IngestorResult. How the bytes were obtained is deliberately
 * not this module's concern — GoIngestor gets them via HTTP fetch against a
 * GitHub raw content URL, LocalGoIngestor via filesystem reads against a
 * cloned repo path. Both call parseGoModContent() so a go.mod is interpreted
 * identically regardless of where it came from — mirrors npm-parse.ts's own
 * fetch/parse split. Single-source shape (like npm-parse.ts), not the
 * primary/fallback shape pypi-parse.ts needed — go.mod has no equivalent of
 * a requirements.txt fallback.
 *
 * Scope (ADR 0024, Decision 2):
 *   - Only `require` directives are read, both forms go.mod allows:
 *       single-line: require github.com/foo/bar v1.2.3
 *       grouped:     require (
 *                        github.com/foo/bar v1.2.3
 *                        github.com/baz/qux v0.4.0 // indirect
 *                    )
 *     Real go.mod files can and do contain more than one `require (...)`
 *     block in a single file (confirmed against gin-gonic/gin's real
 *     go.mod, which has three separate require sections) — this parser
 *     does not assume at most one.
 *   - Requires with a trailing `// indirect` comment are excluded — this
 *     project only ingests direct dependencies (mission-scorer.ts's
 *     `is_transitive: false`, unchanged since Phase 1/2 — see ADR 0007
 *     §2), and `// indirect` is go.mod's own way of marking exactly that
 *     distinction. Not warned about — this is expected filtering, not a
 *     data-quality problem, same treatment npm-parse.ts gives dependency
 *     types it simply doesn't ingest.
 *   - Every included require maps to dep_type "production" — go.mod has no
 *     dev/peer/optional concept to map to the other three enum values,
 *     same "flat list" precedent requirements.txt already set in
 *     pypi-parse.ts.
 *   - `module`/`go`/`toolchain` directive lines are recognized and skipped
 *     (not dependencies). `replace`/`exclude`/`retract` directives —
 *     single-line or grouped — are real, common, and deliberately not
 *     interpreted; their lines never match the `require` patterns this
 *     parser looks for, so they're inert rather than needing to be
 *     specially skipped.
 *   - Module paths with a major-version suffix (`github.com/foo/bar/v2`)
 *     are treated as an opaque package_name — no attempt to strip or
 *     specially interpret the `/vN` suffix, same treatment npm gives a
 *     scoped package name (`@scope/pkg`).
 *   - version_spec is captured verbatim, unvalidated — same choice
 *     npm-parse.ts already makes (no semver-format check on a
 *     package.json version string either). Go module versions are real
 *     SemVer in practice, but validating that here would only reject
 *     entries this module has no better action to take on than passing
 *     them through anyway.
 *   - go.sum (the lock file) is detected but not parsed — same "detect,
 *     don't parse" treatment npm-parse.ts's LOCK_FILE_NAMES gets.
 *
 * A go.mod with a `module` directive but no `require` block at all is a
 * real, valid file (confirmed against gorilla/mux's actual go.mod) and
 * stays manifest_resolved: true with zero dependencies — same precedent
 * npm's genuinely-empty package.json and PyPI's genuinely-empty
 * dependencies = [] already set. Only a missing file, or one with no
 * recognizable `module` directive at all (likely not a real go.mod),
 * becomes manifest_resolved: false.
 *
 * ADR: docs/adr/0024-phase7-go-ecosystem.md
 */

import type { IngestorResult, ParsedDependency } from "./interface.js";

/**
 * Go's lock-file equivalent — presence detected but not parsed, same
 * "detect, don't parse" treatment every other ecosystem's lock file(s)
 * get. Only one real name, unlike LOCK_FILE_NAMES/PYTHON_LOCK_FILE_NAMES,
 * but kept as a named array for shape-consistency with those two and so
 * callers (go.ts, local-go.ts) have one canonical place to reference it.
 */
export const GO_LOCK_FILE_NAMES = ["go.sum"] as const;

/**
 * Parses already-fetched/read go.mod content into structured dependencies.
 *
 * @param raw - the raw go.mod text, or null if none was found at all (e.g.
 *   HTTP 404, or ENOENT on a local read).
 * @param lockFilePresent - whether go.sum was detected at the same
 *   location. Ignored when raw is null or the file has no `module`
 *   directive — mirrors npm-parse.ts: with nothing to resolve confidence
 *   against, there's no point reporting it either way.
 * @param source - human-readable description of where this content came
 *   from, used only in warning messages — a URL for HTTP fetches, a file
 *   path for local reads.
 */
export function parseGoModContent(
  raw: string | null,
  lockFilePresent: boolean,
  source: string,
): IngestorResult {
  const warnings: string[] = [];

  if (raw === null) {
    warnings.push(`No go.mod found at ${source}. Repository skipped.`);
    return unresolved(warnings);
  }

  const lines = raw.split(/\r?\n/);
  const dependencies: ParsedDependency[] = [];
  let sawModuleDirective = false;

  let i = 0;
  while (i < lines.length) {
    // lines[i] is guaranteed defined by the `i < lines.length` guard above,
    // but TypeScript's noUncheckedIndexedAccess can't prove that for a
    // variable index — the `?? ""` fallback is unreachable in practice, not
    // a behavior change.
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("//")) {
      i++;
      continue;
    }

    if (trimmed.startsWith("module ") || trimmed === "module") {
      sawModuleDirective = true;
      i++;
      continue;
    }

    if (trimmed.startsWith("require (")) {
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() !== ")") {
        const entryLine = (lines[i] ?? "").trim();
        i++;
        if (entryLine === "" || entryLine.startsWith("//")) continue;
        parseRequireEntry(entryLine, source, dependencies, warnings);
      }
      // Advance past the closing ")" if we stopped because we found one
      // rather than because we ran off the end of the file (a malformed/
      // truncated block) — either way, the outer loop resumes safely.
      if (i < lines.length) i++;
      continue;
    }

    if (trimmed.startsWith("require ")) {
      const rest = trimmed.slice("require ".length).trim();
      parseRequireEntry(rest, source, dependencies, warnings);
      i++;
      continue;
    }

    // go, toolchain, replace/exclude/retract (single-line or grouped), and
    // any other directive — not this parser's concern. Grouped-block
    // bodies for these (e.g. a multi-line `replace (...)`) never match
    // the `require` prefixes above, so no special skip-tracking is needed
    // for them; each of their lines just falls through here in turn.
    i++;
  }

  if (!sawModuleDirective) {
    warnings.push(
      `No "module" directive found in go.mod at ${source} — this doesn't look like a valid go.mod file. Repository skipped.`,
    );
    return unresolved(warnings);
  }

  if (!lockFilePresent) {
    warnings.push(
      "No lock file detected (go.sum). Dependency versions are unresolved; confidence scores will be lower.",
    );
  }

  if (dependencies.length === 0) {
    warnings.push("go.mod contains no direct require entries.");
  }

  return {
    ecosystem: "go",
    dependencies,
    lock_file_present: lockFilePresent,
    manifest_resolved: true,
    warnings,
  };
}

function unresolved(warnings: string[]): IngestorResult {
  return {
    ecosystem: "go",
    dependencies: [],
    lock_file_present: false,
    manifest_resolved: false,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// require-entry parsing
// ---------------------------------------------------------------------------

/**
 * Parses a single require entry — either the argument portion of a
 * single-line `require <entry>` directive, or one line from inside a
 * `require (...)` block — in the form:
 *
 *   <module-path> <version> [// indirect]
 *
 * Pushes a ParsedDependency onto `dependencies` when the entry is a valid,
 * direct (non-indirect) require. Indirect requires are excluded silently
 * (expected filtering, not a warning-worthy problem — see module
 * docstring); malformed or invalid entries are warned about and skipped,
 * same "never throw, report via warnings" contract every ingestor follows.
 */
function parseRequireEntry(
  entryLine: string,
  source: string,
  dependencies: ParsedDependency[],
  warnings: string[],
): void {
  // Module paths and versions never contain "//" themselves, so the first
  // occurrence always starts a trailing comment (most commonly `// indirect`,
  // but any comment is handled the same way — only its "indirect"-ness
  // matters here).
  const commentIdx = entryLine.indexOf("//");
  const codePart = (commentIdx === -1 ? entryLine : entryLine.slice(0, commentIdx)).trim();
  const comment = commentIdx === -1 ? "" : entryLine.slice(commentIdx + 2).trim();
  const isIndirect = /^indirect\b/.test(comment);

  if (codePart === "") {
    warnings.push(`Skipping empty or comment-only require entry in go.mod at ${source}.`);
    return;
  }

  const parts = codePart.split(/\s+/);
  if (parts.length < 2) {
    warnings.push(
      `Skipping unparseable require entry in go.mod at ${source}: "${entryLine.trim()}"`,
    );
    return;
  }

  const [modulePath, version] = parts;
  if (modulePath === undefined || version === undefined) {
    warnings.push(
      `Skipping unparseable require entry in go.mod at ${source}: "${entryLine.trim()}"`,
    );
    return;
  }

  if (!isValidGoModulePath(modulePath)) {
    warnings.push(`Skipping invalid module path "${modulePath}" in go.mod at ${source}.`);
    return;
  }

  if (version === "") {
    warnings.push(`Skipping "${modulePath}" in go.mod at ${source}: version is missing.`);
    return;
  }

  if (isIndirect) {
    // Direct dependencies only (ADR 0024, Decision 2) — not a warning,
    // expected and common in real go.mod files.
    return;
  }

  dependencies.push({
    package_name: modulePath,
    version_spec: version,
    dep_type: "production",
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Validates a Go module path against a pragmatic subset of the real rules
 * (https://go.dev/ref/mod#module-path) — enough to reject obviously-bad
 * entries (empty, quoted/escaped paths this parser doesn't attempt to
 * unescape, stray tokens from a malformed line) without implementing the
 * full spec, same "pragmatic subset" approach npm-parse.ts and
 * pypi-parse.ts already take for their own package-name validation.
 *
 * Unlike npm and PyPI, Go module paths are real import paths, not names
 * registered against a central index, and — confirmed via real go.mod
 * files during this ADR's own grounding — commonly contain uppercase
 * letters (e.g. github.com/Masterminds/semver) even though the module
 * proxy protocol case-encodes them at request time (go-registry.ts's
 * concern, not this parser's). Mixed case is deliberately allowed here.
 */
function isValidGoModulePath(path: string): boolean {
  if (path.length === 0) return false;
  // Reject anything carrying a quote/backtick — go.mod allows quoting a
  // module path in rare cases (e.g. one containing characters outside this
  // pattern); unescaping that quoted form is out of scope here, so such an
  // entry is treated as unparseable rather than silently mishandled.
  if (/["'`]/.test(path)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9\-._~/!]*$/.test(path);
}
