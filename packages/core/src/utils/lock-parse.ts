/**
 * Lock File Parser Interface and Registry
 *
 * Consolidates 7 individual lock file parsers behind a common interface.
 * Each parser implementation lives in src/ingestor/lock-parsers/
 */

import type { ParsedDependency, IngestorResult } from "../ingestor/interface.js";
import type { Ecosystem } from "../db/schema.js";

/** Result of parsing a lock file */
export interface LockFileParseResult {
  /** Map: package_name -> resolved version (for direct deps) or package_name@version_spec -> resolved version */
  resolvedVersions: Map<string, string>;
  /** Set of package names that appear ONLY in the lock file (not in manifest) */
  transitivePackages: Set<string>;
  /** Non-fatal warnings during parsing */
  warnings: string[];
  /** Which lock file format was parsed */
  format:
    | "package-lock.json"
    | "pnpm-lock.yaml"
    | "yarn.lock"
    | "poetry.lock"
    | "Pipfile.lock"
    | "pdm.lock"
    | "go.sum";
}

export interface LockFileParser {
  /** Unique identifier for this lock file format */
  readonly format: string;
  /** Ecosystem this parser belongs to */
  readonly ecosystem: Ecosystem;
  /** File names this parser can handle (e.g., ["package-lock.json"]) */
  readonly fileNames: readonly string[];
  /** Whether this format is fully supported (parsed) or just detected */
  readonly supported: boolean;

  /**
   * Parse lock file content and merge with manifest dependencies.
   *
   * @param manifestDeps - Dependencies parsed from manifest files
   * @param lockContent - Raw lock file content
   * @returns Updated dependencies with resolved_version populated, plus lock_file_parsed flag
   */
  parse(
    manifestDeps: ParsedDependency[],
    lockContent: string,
  ): { dependencies: ParsedDependency[]; lockFileParsed: boolean; warnings: string[] };
}

/**
 * Registry of all known lock file parsers.
 * Adding a new parser: implement LockFileParser and register in LOCK_PARSERS.
 */
const LOCK_PARSERS: LockFileParser[] = [];

/**
 * Register a lock file parser.
 * Called by each parser module on import.
 */
export function registerLockFileParser(parser: LockFileParser): void {
  LOCK_PARSERS.push(parser);
}

/**
 * Get all registered parsers.
 */
export function getLockFileParsers(): readonly LockFileParser[] {
  return LOCK_PARSERS;
}

/**
 * Get parsers for a specific ecosystem.
 */
export function getLockFileParsersForEcosystem(ecosystem: Ecosystem): LockFileParser[] {
  return LOCK_PARSERS.filter((p) => p.ecosystem === ecosystem);
}

/**
 * Find a parser by file name.
 */
export function findParserByFileName(fileName: string): LockFileParser | undefined {
  return LOCK_PARSERS.find((p) => p.fileNames.includes(fileName));
}

/**
 * Find a supported parser by file name.
 */
export function findSupportedParserByFileName(fileName: string): LockFileParser | undefined {
  return LOCK_PARSERS.find((p) => p.fileNames.includes(fileName) && p.supported);
}

/**
 * Merge manifest dependencies with lock file data.
 * This is the main entry point used by ingestor factory.
 *
 * @param manifestDeps - Dependencies from manifest parsing
 * @param lockFileContent - Raw lock file content (null if none)
 * @param lockFileName - Name of the lock file (used to select parser)
 * @param _ecosystem - Ecosystem for context (unused, kept for API consistency)
 * @returns Updated IngestorResult fields
 */
export function mergeManifestWithLock(
  manifestDeps: ParsedDependency[],
  lockFileContent: string | null,
  lockFileName: string | null,
  _ecosystem: Ecosystem,
): {
  dependencies: ParsedDependency[];
  lockFileParsed: boolean;
  lockFileFormat: IngestorResult["lock_file_format"] | undefined;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!lockFileContent || !lockFileName) {
    return {
      dependencies: manifestDeps,
      lockFileParsed: false,
      lockFileFormat: undefined,
      warnings,
    };
  }

  const parser = findSupportedParserByFileName(lockFileName);

  if (!parser) {
    // Lock file detected but not supported for parsing
    const detectedParser = findParserByFileName(lockFileName);
    if (detectedParser) {
      warnings.push(
        `Lock file "${lockFileName}" detected but parsing not yet implemented for ${detectedParser.format}. ` +
          `Resolved versions will not be available.`,
      );
    }
    return {
      dependencies: manifestDeps,
      lockFileParsed: false,
      lockFileFormat: lockFileName as IngestorResult["lock_file_format"],
      warnings,
    };
  }

  try {
    const {
      dependencies,
      lockFileParsed,
      warnings: parserWarnings,
    } = parser.parse(manifestDeps, lockFileContent);
    return {
      dependencies,
      lockFileParsed,
      lockFileFormat: lockFileName as IngestorResult["lock_file_format"],
      warnings: [...warnings, ...parserWarnings],
    };
  } catch (err) {
    warnings.push(
      `Failed to parse ${lockFileName}: ${String(err)}. Resolved versions unavailable.`,
    );
    return {
      dependencies: manifestDeps,
      lockFileParsed: false,
      lockFileFormat: lockFileName as IngestorResult["lock_file_format"],
      warnings,
    };
  }
}

/**
 * Detect lock file presence from a list of file names.
 * Returns the first recognized lock file name, or null.
 */
export function detectLockFile(fileNames: readonly string[]): string | null {
  for (const name of fileNames) {
    if (findParserByFileName(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Check if a lock file name is recognized (supported or unsupported).
 */
export function isKnownLockFile(fileName: string): boolean {
  return findParserByFileName(fileName) !== undefined;
}

/**
 * Get all known lock file names for an ecosystem.
 */
export function getKnownLockFileNames(ecosystem: Ecosystem): readonly string[] {
  const parsers = getLockFileParsersForEcosystem(ecosystem);
  return parsers.flatMap((p) => p.fileNames);
}
