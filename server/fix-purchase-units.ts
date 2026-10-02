import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config";
import { migrateDatabase, openDatabase } from "./db/node";
import { FIX_QUERIES, planUnitFix, type FixData } from "./services/unit-fix";

// Corrects order lines imported as meters when the supplier sold bars
// ("HIERRO DIAM.12 X BARRA 12 MT · 172" → 172 barras de 12 m). Dry run by
// default: prints what would change and writes the SQL to
// data/fix-purchase-units.sql. Nothing is written without --apply.
//
//   npm run fix:units -- [--order 1] [--apply]                local SQLite (DATABASE_URL)
//   npm run cf:fix-units -- [--order 1] [--apply]             remote D1 `casa-cordoba` (needs `npx wrangler login`)
//   npm run cf:fix-units -- --d1-local [--order 1] [--apply]  local D1 (wrangler dev)

const D1_DATABASE = "casa-cordoba";
const argv = process.argv.slice(2);
const remote = argv.includes("--remote") || argv.includes("--d1-local");
const d1Local = argv.includes("--d1-local");
const apply = argv.includes("--apply");
const order = argv[argv.indexOf("--order") + 1] && argv.includes("--order") ? argv[argv.indexOf("--order") + 1] : undefined;
const SQL_FILE = "data/fix-purchase-units.sql";

function wrangler(args: string[]): string {
  const run = spawnSync("npx", ["wrangler", "d1", "execute", D1_DATABASE, d1Local ? "--local" : "--remote", ...args], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  if (run.status !== 0) {
    console.error(run.stdout);
    process.exit(run.status ?? 1);
  }
  return run.stdout;
}

async function readData(): Promise<{ data: FixData; execute: (statements: string[]) => Promise<void> }> {
  const data = {} as Record<keyof FixData, unknown[]>;
  if (remote) {
    for (const [key, sql] of Object.entries(FIX_QUERIES) as [keyof FixData, string][]) {
      const out = JSON.parse(wrangler(["--json", "--command", sql])) as { results: unknown[] }[];
      data[key] = out[0]?.results ?? [];
    }
    return {
      data: data as unknown as FixData,
      execute: async () => {
        wrangler(["--file", SQL_FILE]);
      },
    };
  }
  const config = loadConfig();
  const { db, client } = await openDatabase(config.databaseUrl);
  await migrateDatabase(db);
  for (const [key, sql] of Object.entries(FIX_QUERIES) as [keyof FixData, string][]) data[key] = (await client.execute(sql)).rows.map((r) => ({ ...r }));
  return {
    data: data as unknown as FixData,
    execute: async (statements) => {
      await client.batch(statements, "write");
    },
  };
}

const { data, execute } = await readData();
const plan = planUnitFix(data, { order, now: new Date().toISOString(), newId: randomUUID });
const where = remote ? `${D1_DATABASE} (${d1Local ? "D1 local" : "producción"})` : loadConfig().databaseUrl;

if (!plan.lines.length) {
  console.log(`No hay líneas para corregir en ${where}${order ? ` (pedido ${order})` : ""}.`);
  for (const s of plan.skipped) console.log(`  · omitida: pedido ${s.order} «${s.description}»: ${s.reason}`);
  process.exit(0);
}
console.log(`Líneas a corregir en ${where}:`);
for (const l of plan.lines) console.log(`  · pedido ${l.order} «${l.description}»: ${l.before} → ${l.after}`);
for (const m of plan.materials) console.log(`  · material ${m.before} → ${m.after}${m.notes.length ? ` (${m.notes.join("; ")})` : ""}`);
for (const s of plan.skipped) console.log(`  · omitida: pedido ${s.order} «${s.description}»: ${s.reason}`);
mkdirSync("data", { recursive: true });
writeFileSync(SQL_FILE, `${plan.statements.join("\n")}\n`);
console.log(`SQL en ${SQL_FILE} (${plan.statements.length} sentencias).`);
if (!apply) {
  console.log("Prueba sin cambios. Para aplicar, repite con --apply.");
  process.exit(0);
}
await execute(plan.statements);
console.log("Corrección aplicada.");
