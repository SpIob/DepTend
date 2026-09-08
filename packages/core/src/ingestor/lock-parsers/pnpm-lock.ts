/**
 * pnpm-lock.yaml parser (not yet implemented - detection only)
 */

import type { LockFileParser } from "../../utils/lock-parse.js";
import type { ParsedDependency } from "../../ingestor/interface.js";
import { registerLockFileParser } from "../../utils/lock-parse.js";

const pnpmLockParser: LockFileParser = {
  format: "pnpm-lock.yaml",
  ecosystem: "npm",
  fileNames: ["pnpm-lock.yaml"] as const,
  supported: false,

  parse(
    _manifestDeps: ParsedDependency[],
    _content: string,
  ): { dependencies: ParsedDependency[]; lockFileParsed: boolean; warnings: string[] } {
    return {
      dependencies: [],
      lockFileParsed: false,
      warnings: ["pnpm-lock.yaml parsing not yet implemented"],
    };
  },
};

registerLockFileParser(pnpmLockParser);
export { pnpmLockParser };
