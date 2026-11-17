/**
 * pnpm-lock.yaml parsing — pure, no I/O, no external YAML dependency
 *
 * Parses pnpm lockfileVersion 6.0 (pnpm 8) and 9.0 (pnpm 9+) formats.
 * Reads the root importer (`.`) section for direct dependencies with their
 * resolved versions. Workspace multi-importer lockfiles: only the root
 * importer is parsed; non-root importers are treated as not-parsed.
 *
 * Unknown lockfileVersion sets a warning and returns empty result — never crashes.
 *
 * ADR: docs/adr/0038-lock-file-parsing.md
 */

import type { LockFileParseResult } from "./lock-parse.js";

/**
 * Parse pnpm-lock.yaml content (lockfileVersion 6.0 or 9.0).
 * Returns resolved versions for direct dependencies from the root importer.
 */
export function parsePnpmLockContent(content: string): LockFileParseResult {
  const warnings: string[] = [];
  const resolvedVersions = new Map<string, string>();
  const transitivePackages = new Set<string>();

  // Parse the YAML content with our bounded hand-rolled parser
  const parsed = parsePnpmLockYaml(content, warnings);

  if (!parsed) {
    // parsePnpmLockYaml adds its own warnings
    return { resolvedVersions, transitivePackages, warnings, format: "pnpm-lock.yaml" };
  }

  // Check lockfileVersion
  const lockfileVersion = parsed.lockfileVersion;
  if (typeof lockfileVersion !== "string" && typeof lockfileVersion !== "number") {
    warnings.push("pnpm-lock.yaml: missing or invalid lockfileVersion");
    return { resolvedVersions, transitivePackages, warnings, format: "pnpm-lock.yaml" };
  }

  const versionStr = String(lockfileVersion);
  const majorVersion = versionStr.split(".")[0];

  if (majorVersion !== "6" && majorVersion !== "9") {
    warnings.push(
      `pnpm-lock.yaml: unsupported lockfileVersion ${versionStr} (expected 6.x or 9.x) — lock file not parsed`,
    );
    return { resolvedVersions, transitivePackages, warnings, format: "pnpm-lock.yaml" };
  }

  // Extract root importer dependencies
  const importers = parsed.importers;
  if (!importers || typeof importers !== "object") {
    warnings.push("pnpm-lock.yaml: no importers section found");
    return { resolvedVersions, transitivePackages, warnings, format: "pnpm-lock.yaml" };
  }

  const rootImporter = importers["."];
  if (!rootImporter || typeof rootImporter !== "object") {
    warnings.push("pnpm-lock.yaml: no root importer ('.') found");
    return { resolvedVersions, transitivePackages, warnings, format: "pnpm-lock.yaml" };
  }

  const root = rootImporter as Record<string, unknown>;

  // Dependency types we care about (direct dependencies of the root package)
  const depTypes = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

  for (const depType of depTypes) {
    const deps = root[depType];
    if (deps && typeof deps === "object") {
      for (const [pkgName, depInfo] of Object.entries(deps as Record<string, unknown>)) {
        if (depInfo && typeof depInfo === "object") {
          const info = depInfo as Record<string, unknown>;
          const version = info.version;
          const specifier = info.specifier;

          if (typeof version === "string" && version.length > 0) {
            // Store with both exact key (name@specifier) and name-only for matching
            // pnpm sometimes includes peer dep info in version like "7.34.4(@types/node@18.15.5)"
            // Extract just the version number
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const cleanVersion = version.split("(")[0]!;
            const versionSpec = typeof specifier === "string" ? specifier : "*";
            resolvedVersions.set(`${pkgName}@${versionSpec}`, cleanVersion);
            resolvedVersions.set(pkgName, cleanVersion);
          } else if (typeof version === "string") {
            warnings.push(`pnpm-lock.yaml: empty version for dependency ${pkgName}`);
          } else {
            warnings.push(`pnpm-lock.yaml: missing or invalid version for dependency ${pkgName}`);
          }
        }
      }
    }
  }

  // For transitive packages, we scan the packages/snapshots sections
  // But per the existing pattern (like cargo-lock, go-sum), we add all
  // package names from the lockfile as transitive candidates, and
  // mergeManifestWithLock will filter out the ones that are in the manifest.
  // We only have the root importer's direct deps here, so we mark everything
  // else we can find as transitive.

  // Extract package names from packages (v6) or packages+snapshots (v9)
  const packages = parsed.packages;
  if (packages && typeof packages === "object") {
    for (const pkgKey of Object.keys(packages)) {
      // Package keys are like "pkg@1.0.0" or "/pkg@1.0.0"
      const pkgName = extractPackageNameFromKey(pkgKey);
      if (pkgName && !resolvedVersions.has(pkgName)) {
        transitivePackages.add(pkgName);
      }
    }
  }

  const snapshots = parsed.snapshots;
  if (snapshots && typeof snapshots === "object") {
    for (const snapKey of Object.keys(snapshots)) {
      const pkgName = extractPackageNameFromKey(snapKey);
      if (pkgName && !resolvedVersions.has(pkgName)) {
        transitivePackages.add(pkgName);
      }
    }
  }

  return { resolvedVersions, transitivePackages, warnings, format: "pnpm-lock.yaml" };
}

/**
 * Extract package name from a pnpm package/snapshot key.
 * Keys look like: "pkg@1.0.0", "/pkg@1.0.0", "pkg@1.0.0(peer@1.0.0)", etc.
 */
function extractPackageNameFromKey(key: string): string | null {
  // Remove leading slash if present
  const cleaned = key.startsWith("/") ? key.slice(1) : key;

  // Find the last @ that separates name from version
  // For scoped packages: @scope/pkg@1.0.0 -> last @ is before version
  const lastAt = cleaned.lastIndexOf("@");
  if (lastAt <= 0) return null; // No version part or malformed

  // For scoped packages, we need to find the @ that separates scope from name
  // But the last @ is always the version separator
  const namePart = cleaned.slice(0, lastAt);

  // Handle peer dependency suffix: pkg@1.0.0(peer@1.0.0) -> extract pkg
  const parenIndex = namePart.indexOf("(");
  if (parenIndex > 0) {
    return namePart.slice(0, parenIndex);
  }

  return namePart;
}

/**
 * Bounded hand-rolled YAML parser for pnpm-lock.yaml subset.
 * Supports: two-space indentation, key: value, quoted strings, nested objects, lists.
 * Returns null on parse failure (with warnings populated).
 */
function parsePnpmLockYaml(
  content: string,
  warnings: string[],
): {
  lockfileVersion: string | number | null;
  importers: Record<string, unknown> | null;
  packages: Record<string, unknown> | null;
  snapshots: Record<string, unknown> | null;
} | null {
  const lines = content.split("\n");
  const root: Record<string, unknown> = {};
  // Stack of { indent, obj } where obj is the current object being populated
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Calculate indent (count leading spaces)
    const indentMatch = /^(\s*)/.exec(line);
    const indent = indentMatch?.[1]?.length ?? 0;

    // Handle list items (starting with "- ")
    if (trimmed.startsWith("- ")) {
      // Lists in pnpm-lock.yaml are typically under packages/snapshots
      // We don't need to fully parse list contents for our use case
      continue;
    }

    // Find the matching stack level - pop until we find parent with less indent
    // stack always has at least the root entry (indent -1), so stack.length >= 1 always
    while (stack.length > 1 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      stack.pop();
    }

    // stack always has at least the root entry (indent -1)
    const parent = stack[stack.length - 1] as { indent: number; obj: Record<string, unknown> };

    // Parse key: value
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      // Malformed line - skip with warning
      const lineNum = String(i + 1);
      warnings.push(`pnpm-lock.yaml: malformed line ${lineNum}: ${trimmed.slice(0, 50)}`);
      continue;
    }

    const rawKey = trimmed.slice(0, colonIndex).trim();
    // Parse key as YAML value to handle quoted keys like '@babel/types'
    const key = parseYamlValue(rawKey) as string;
    const valueStr = trimmed.slice(colonIndex + 1).trim();

    // Check if this is a nested object (empty value means nested object follows)
    const isNestedObject = valueStr === "" || valueStr === "|" || valueStr === ">";

    let value: unknown;
    if (isNestedObject && valueStr !== "|" && valueStr !== ">") {
      // Empty value - create new object for nested content
      value = {};
      // Push this new object onto the stack for subsequent indented lines
      stack.push({ indent, obj: value as Record<string, unknown> });
    } else if (valueStr === "|" || valueStr === ">") {
      // Multi-line string - we don't need the content for our use case
      value = "";
      // Skip subsequent indented lines
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine === undefined) break;
        const nextIndentMatch = /^(\s*)/.exec(nextLine);
        const nextIndent = nextIndentMatch?.[1]?.length ?? 0;
        if (nextIndent > indent) {
          i++;
        } else {
          break;
        }
      }
    } else {
      // Regular value
      value = parseYamlValue(valueStr);
    }

    // Store in parent object
    if (key === "lockfileVersion") {
      // Keep at root level
      root[key] = value;
    } else {
      parent.obj[key] = value;
    }
  }

  return {
    lockfileVersion: root.lockfileVersion as string | number | null,
    importers: root.importers as Record<string, unknown> | null,
    packages: root.packages as Record<string, unknown> | null,
    snapshots: root.snapshots as Record<string, unknown> | null,
  };
}

/**
 * Parse a YAML value (string, number, boolean, null).
 */
function parseYamlValue(valueStr: string): unknown {
  // Empty value -> null
  if (valueStr === "" || valueStr === "~") return null;

  // Quoted strings
  if (
    (valueStr.startsWith('"') && valueStr.endsWith('"')) ||
    (valueStr.startsWith("'") && valueStr.endsWith("'"))
  ) {
    // Remove quotes and handle escapes (basic)
    let unquoted = valueStr.slice(1, -1);
    if (valueStr.startsWith('"')) {
      // Handle basic escapes in double-quoted strings
      unquoted = unquoted
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t");
    } else {
      // Single-quoted: '' -> '
      unquoted = unquoted.replace(/''/g, "'");
    }
    return unquoted;
  }

  // Boolean
  if (valueStr === "true") return true;
  if (valueStr === "false") return false;

  // Null
  if (valueStr === "null" || valueStr === "~") return null;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(valueStr)) {
    const num = Number(valueStr);
    if (!Number.isNaN(num)) return num;
  }

  // Unquoted string
  return valueStr;
}
