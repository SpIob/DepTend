// Patches Node's ESM loader so that any static `import { parse } from '@yarnpkg/lockfile'`
// resolves to the actual CJS named export. The dep's own module.exports.parse
// is set explicitly (per its index.js: `module.exports.parse = parse`), but
// Node 22.23 ESM still rejects the static named import path. This is a
// workaround for an environment-only limitation — the source files in
// packages/core/src/ingestor/ use this named import pattern and work fine
// under Next.js / Vitest, which both run a different module graph.
//
// Not for production. For local manual ingestion runs only.
import { register } from "node:module";

register(new URL("./patch-yarn-lockfile.mjs", import.meta.url), import.meta.url);
