import { defineConfig } from "drizzle-kit";

// Migrations are plain SQLite SQL, usable by libsql locally and by
// `wrangler d1 migrations apply` on Cloudflare D1.
export default defineConfig({
  dialect: "sqlite",
  schema: "./server/db/schema.ts",
  out: "./drizzle",
});
