/**
 * Lock File Parsers - Auto-registration entry point
 *
 * Importing this module registers all lock file parsers with the global registry.
 * Individual parsers can also be imported directly if needed.
 */

import "./package-lock.js";
import "./yarn-lock.js";
import "./pnpm-lock.js";
import "./poetry-lock.js";
import "./pipfile-lock.js";
import "./pdm-lock.js";
import "./go-sum.js";

// Re-export for direct access if needed
export { packageLockParser } from "./package-lock.js";
export { yarnLockParser } from "./yarn-lock.js";
export { pnpmLockParser } from "./pnpm-lock.js";
export { poetryLockParser } from "./poetry-lock.js";
export { pipfileLockParser } from "./pipfile-lock.js";
export { pdmLockParser } from "./pdm-lock.js";
export { goSumParser } from "./go-sum.js";
