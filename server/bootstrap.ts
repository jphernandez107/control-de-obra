import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { UNITS } from "./dev/catalog";

// Writes the minimal production bootstrap (one project, the people who can
// sign in, and the unit reference table) as SQL for
// `wrangler d1 execute casa-cordoba --remote --file data/bootstrap.sql`.
// Re-running it against a database that already has a project changes nothing.
//
//   npm run cf:bootstrap -- --project "Casa Córdoba" --user "Nombre|email@dominio|propietario" [--user …]

const ROLES = new Set(["propietario", "ingeniero", "otro"]);

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

const projectName = args("project")[0] ?? "Casa Córdoba";
const users = args("user").map((spec) => {
  const [name, email, role = "propietario"] = spec.split("|").map((s) => s.trim());
  if (!name || !email || !/^[^@\s]+@[^@\s]+$/.test(email) || !ROLES.has(role)) {
    throw new Error(`Usuario inválido: «${spec}». Formato: "Nombre|email|propietario|ingeniero|otro"`);
  }
  return { id: randomUUID(), name, email: email.toLowerCase(), role };
});
if (!users.length) throw new Error('Indica al menos un usuario con --user "Nombre|email|rol".');

const projectId = randomUUID();
const now = new Date().toISOString();
const sql = [
  ...UNITS.map((u) => `INSERT OR IGNORE INTO units (code, label, singular, plural) VALUES (${q(u.code)}, ${q(u.label)}, ${q(u.singular)}, ${q(u.plural)});`),
  `INSERT INTO projects (id, name, timezone, currency, created_at) SELECT ${q(projectId)}, ${q(projectName)}, 'America/Argentina/Cordoba', 'ARS', ${q(now)} WHERE NOT EXISTS (SELECT 1 FROM projects);`,
  ...users.map(
    (u) =>
      `INSERT INTO users (id, project_id, name, role, email, can_login, created_at) SELECT ${q(u.id)}, ${q(projectId)}, ${q(u.name)}, ${q(u.role)}, ${q(u.email)}, 1, ${q(now)} WHERE EXISTS (SELECT 1 FROM projects WHERE id = ${q(projectId)});`,
  ),
].join("\n");

mkdirSync("data", { recursive: true });
writeFileSync("data/bootstrap.sql", `${sql}\n`);
console.log(`SQL escrito en data/bootstrap.sql (proyecto «${projectName}», ${users.length} usuario(s)). Aplicar con:\n  npx wrangler d1 execute casa-cordoba --remote --file data/bootstrap.sql`);
