import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.bench.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    benchmark: {
      outputJson: "./benchmark-results.json",
      update: false,
    },
  },
});
