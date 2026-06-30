import { defineConfig } from "drizzle-kit";

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
