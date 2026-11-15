import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Resolves the "@/..." alias app source uses (mirrors app/tsconfig.json's
// paths entry) so route/component tests can import the modules they cover.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    // Strips any ambient Upstash credentials so the suites always exercise
    // the in-memory limiter path (see vitest.setup.ts). CI sets none, so this
    // only changes local runs — it stops a developer's exported
    // .env.local from writing real rate-limit keys to production.
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
