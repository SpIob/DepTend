/**
 * GoIngestor — HTTP-based ingestor for Go ecosystem.
 *
 * Thin re-export of createHttpIngestor factory with Go-specific config.
 * See factory.ts for shared implementation.
 *
 * ADR: docs/adr/0024-phase7-go-ecosystem.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import { createHttpIngestor } from "./factory.js";
import { GO_LOCK_FILE_NAMES, parseGoModContent } from "./go-parse.js";

export const GoIngestor = createHttpIngestor({
  ecosystem: "go",
  manifestFiles: ["go.mod"],
  lockFileNames: GO_LOCK_FILE_NAMES,
  parseManifest: (manifests, lockFilePresent, lockFileContent, lockFileName) =>
    Promise.resolve(
      parseGoModContent(
        manifests[0]?.raw ?? null,
        lockFilePresent,
        manifests[0]?.source ?? "",
        lockFileContent,
        lockFileName,
      ),
    ),
});
