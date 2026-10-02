import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { eq } from "drizzle-orm";
import { loadConfig } from "./config";
import { migrateDatabase, openDatabase } from "./db/node";
import * as t from "./db/schema";
import { hashPassword, MIN_PASSWORD_LENGTH, normalizeUsername, USERNAME_PATTERN } from "./http/auth";

// Sets (or resets) a user's password from the command line. Used once for the
// administrator in production, and to recover a forgotten password. Signs the
// user out of every device.
//
//   npm run user:password -- juan    local database (DATABASE_URL)
//   npm run cf:password -- juan      remote D1 `casa-cordoba` (needs `npx wrangler login`)
//   npm run cf:password -- juan --d1-local   the local D1 used by `npm run cf:dev`
//
// The password is read from the terminal without echo, or from stdin when piped.

const D1_DATABASE = "casa-cordoba";

const d1Local = process.argv.includes("--d1-local");
const remote = process.argv.includes("--remote");
const username = normalizeUsername(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "");
if (!USERNAME_PATTERN.test(username)) {
  console.error("Uso: npm run user:password -- <usuario>   (o cf:password para producción)");
  process.exit(1);
}

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide what is typed: print the prompt once, swallow the echo.
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (s.startsWith(question)) write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readPiped();
  const first = await ask(`Nueva contraseña para ${username}: `);
  const second = await ask("Repítela: ");
  if (first !== second) {
    console.error("Las contraseñas no coinciden.");
    process.exit(1);
  }
  return first;
}

const password = await readPassword();
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  process.exit(1);
}
const hash = await hashPassword(password);

if (remote) {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const command = [
    `UPDATE users SET password_hash = ${q(hash)}, can_login = 1 WHERE username = ${q(username)}`,
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ${q(username)})`,
  ].join("; ");
  const run = spawnSync("npx", ["wrangler", "d1", "execute", D1_DATABASE, d1Local ? "--local" : "--remote", "--json", "--command", command], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  if (run.status !== 0) {
    console.error(run.stdout);
    process.exit(run.status ?? 1);
  }
  let changes: number | null = null;
  try {
    changes = (JSON.parse(run.stdout) as { meta?: { changes?: number } }[])[0]?.meta?.changes ?? null;
  } catch {
    console.log(run.stdout);
  }
  if (changes === 0) {
    console.error(`No existe el usuario «${username}» en ${D1_DATABASE}.`);
    process.exit(1);
  }
  console.log(`Contraseña de «${username}» actualizada en ${D1_DATABASE} (${d1Local ? "D1 local" : "producción"}).`);
} else {
  const config = loadConfig();
  const { db } = await openDatabase(config.databaseUrl);
  await migrateDatabase(db);
  const [user] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.username, username));
  if (!user) {
    console.error(`No existe el usuario «${username}» en ${config.databaseUrl}.`);
    process.exit(1);
  }
  await db.batch([db.update(t.users).set({ passwordHash: hash, canLogin: true }).where(eq(t.users.id, user.id)), db.delete(t.sessions).where(eq(t.sessions.userId, user.id))]);
  console.log(`Contraseña de «${username}» actualizada en ${config.databaseUrl}.`);
}
