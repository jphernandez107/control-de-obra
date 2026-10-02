import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export { schema };

/**
 * Database handle used by repositories and services. Both the local libsql
 * driver and Cloudflare D1 (`drizzle-orm/d1`) satisfy it: async SQLite with
 * an atomic `batch()`. Multi-record writes go through `batch()` because D1
 * has no interactive transactions.
 */
export type AppDb = BaseSQLiteDatabase<"async", unknown, typeof schema> & {
  batch: LibSQLDatabase<typeof schema>["batch"];
};
