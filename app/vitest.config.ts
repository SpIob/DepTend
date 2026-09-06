import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Resolves the "@/..." alias app source uses (mirrors app/tsconfig.json's
// paths entry) so route/component tests can import the modules they cover.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
