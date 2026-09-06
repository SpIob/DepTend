/**
 * NpmIngestor — HTTP-based ingestor for npm ecosystem.
 *
 * Thin re-export of createHttpIngestor factory with npm-specific config.
 * See factory.ts for shared implementation.
 *
 * ADR: docs/adr/0003-npm-ecosystem-first.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import { createHttpIngestor } from "./factory.js";
import { LOCK_FILE_NAMES, parsePackageJsonContent } from "./npm-parse.js";

export const NpmIngestor = createHttpIngestor({
  ecosystem: "npm",
  manifestFiles: ["package.json"],
  lockFileNames: LOCK_FILE_NAMES,
  parseManifest: (manifests, lockFilePresent, lockFileContent, lockFileName) =>
    Promise.resolve(
      parsePackageJsonContent(
        manifests[0]?.raw ?? null,
        lockFilePresent,
        manifests[0]?.source ?? "",
        lockFileContent,
        lockFileName,
      ),
    ),
  unsupportedLockFiles: ["pnpm-lock.yaml"],
});
