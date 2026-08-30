// Vitest config for the scripts/ workspace.
//
// Plain JS only — no tsconfig dependency. The file extension is .mjs
// (not .ts) on purpose: the project's ESLint config typed-lints every
// .ts file with a parserOptions.project entry, and scripts/ has no
// tsconfig, so a .ts config would fail lint. .mjs sits cleanly inside
// the existing `scripts/**/*.{js,mjs}` block of eslint.config.mjs.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
