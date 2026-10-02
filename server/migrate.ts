import { loadConfig } from "./config";
import { migrateDatabase, openDatabase } from "./db/node";

const config = loadConfig();
const { db, client } = await openDatabase(config.databaseUrl);
await migrateDatabase(db);
client.close();
console.log(`Migraciones aplicadas en ${config.databaseUrl}`);
