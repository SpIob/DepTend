import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit is a bare Node CLI, not part of Next.js's dev/build process —
// unlike `next dev`/`next build`, nothing loads .env.local for it
// automatically. Silently does nothing if the file doesn't exist (CI,
// where DATABASE_URL_UNPOOLED is already injected directly as a real
// environment variable).
config({ path: ".env.local" });

export default defineConfig({
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ??
      ((): never => {
        throw new Error("DATABASE_URL_UNPOOLED is not set");
      })(),
  },
});
