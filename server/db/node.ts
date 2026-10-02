import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { AppDb } from "./client";
import * as schema from "./schema";

// Node-only database adapter (libsql/SQLite file). On Cloudflare this file is
// replaced by `drizzle(env.DB, { schema })` from `drizzle-orm/d1`.

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function openDatabase(url: string): Promise<{ db: AppDb; client: Client }> {
  if (url.startsWith("file:") && !url.includes(":memory:")) mkdirSync(dirname(resolve(url.slice(5))), { recursive: true });
  const client = createClient({ url });
  // D1 always enforces foreign keys; SQLite needs it per connection.
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema }) as unknown as AppDb;
  return { db, client };
}

export async function migrateDatabase(db: AppDb): Promise<void> {
  await migrate(db as never, { migrationsFolder: MIGRATIONS_DIR });
}
