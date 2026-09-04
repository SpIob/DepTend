// ESM loader hook: rewrites imports of @yarnpkg/lockfile so the static
// `import { parse } from '@yarnpkg/lockfile'` succeeds in plain Node 22
// ESM (which the dep's CommonJS shape doesn't otherwise satisfy).
//
// The hook re-exports the entire module as both default and namespace so
// every consumer — `import x`, `import * as x`, `import { parse }` — works.
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const TARGETS = new Set(["@yarnpkg/lockfile"]);

export async function resolve(specifier, context, nextResolve) {
  if (TARGETS.has(specifier)) {
    const require = createRequire(import.meta.url);
    // Resolve via CJS resolution so we land on the real file
    const resolved = require.resolve(specifier);
    return { url: pathToFileURL(resolved).href, shortCircuit: true, format: "commonjs" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes("@yarnpkg/lockfile")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
import { createRequire } from "node:module";
const _req = createRequire(${JSON.stringify(url)});
const _m = _req(${JSON.stringify(fileURLToPath(url))});
const _named = new Proxy(_m, { has: (t, k) => k in t, get: (t, k) => t[k] });
export default _named;
export const parse = _m.parse;
export const stringify = _m.stringify;
`,
    };
  }
  return nextLoad(url, context);
}
