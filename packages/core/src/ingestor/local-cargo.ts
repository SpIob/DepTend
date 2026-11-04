/**
 * LocalCargoIngestor — filesystem-based ingestor for the Cargo (crates.io)
 * ecosystem.
 *
 * Thin re-export of createLocalIngestor factory with Cargo-specific config.
 * See factory.ts for shared implementation.
 *
 * ADR: docs/adr/0063-cargo-ecosystem.md
 */

import { createLocalIngestor } from "./factory.js";
import { CARGO_LOCK_FILE_NAMES, parseCargoTomlContent } from "./cargo-parse.js";

export const LocalCargoIngestor = createLocalIngestor({
  ecosystem: "cargo",
  manifestFiles: ["Cargo.toml"],
  lockFileNames: CARGO_LOCK_FILE_NAMES,
  parseManifest: (manifests, lockFilePresent, lockFileContent, lockFileName) =>
    Promise.resolve(
      parseCargoTomlContent(
        manifests[0]?.raw ?? null,
        lockFilePresent,
        manifests[0]?.source ?? "",
        lockFileContent,
        lockFileName,
      ),
    ),
});
