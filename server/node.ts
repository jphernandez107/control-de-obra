import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { createProvider } from "./ai/factory";
import { loadConfig } from "./config";
import { migrateDatabase, openDatabase } from "./db/node";
import { projects } from "./db/schema";
import { createApp } from "./http/app";
import { LocalFileStorage } from "./storage/local";

// Local development server: SQLite file + filesystem documents + configured AI provider.

const config = loadConfig();
const { db } = await openDatabase(config.databaseUrl);
await migrateDatabase(db);

const project = config.projectId ? (await db.select().from(projects).where(eq(projects.id, config.projectId)))[0] : (await db.select().from(projects).limit(1))[0];
if (!project) {
  console.error("No hay ningún proyecto en la base de datos. Ejecuta `npm run db:seed` (datos de demo) o `npm run db:seed -- --empty`.");
  process.exit(1);
}

const ai = createProvider(config);
const app = createApp({
  db,
  storage: new LocalFileStorage(config.documentsDir),
  ai,
  projectId: project.id,
  auth: { mode: config.authMode, devUserEmail: config.devUserEmail },
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API de Casa Córdoba en http://localhost:${info.port}/api · proyecto «${project.name}» · IA: ${ai.name}${ai.model ? ` (${ai.model})` : ""}`);
});
