/**
 * LocalPyPIIngestor — filesystem-based ingestor for PyPI ecosystem.
 *
 * Thin re-export of createLocalIngestor factory with PyPI-specific config.
 * See factory.ts for shared implementation.
 *
 * ADR: docs/adr/0022-phase6-pypi-ecosystem.md
 *      docs/adr/0038-lock-file-parsing.md
 */

import { createLocalIngestor } from "./factory.js";
import { PYTHON_LOCK_FILE_NAMES, parsePyPIManifests } from "./pypi-parse.js";

export const LocalPyPIIngestor = createLocalIngestor({
  ecosystem: "pypi",
  manifestFiles: ["pyproject.toml", "requirements.txt"],
  lockFileNames: PYTHON_LOCK_FILE_NAMES,
  parseManifest: (manifests, lockFilePresent, lockFileContent, lockFileName) =>
    Promise.resolve(
      parsePyPIManifests(
        manifests[0]?.raw ?? null,
        manifests[1]?.raw ?? null,
        lockFilePresent,
        manifests[0]?.source ?? "",
        manifests[1]?.source ?? "",
        lockFileContent,
        lockFileName,
      ),
    ),
});
