import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MockAIProvider } from "../server/ai/mock";
import * as t from "../server/db/schema";
import { MIGRATIONS_DIR } from "../server/db/node";
import { createApp } from "../server/http/app";
import { hashPassword, PASSWORD_ITERATIONS, verifyPassword, type AuthConfig } from "../server/http/auth";
import { DEMO_PASSWORD } from "../server/seed";
import { NOW, setup } from "./helpers";

// Username + password sign-in, sessions, and the administrator-only user manager.

async function sessionApp(auth: Partial<AuthConfig> = {}) {
  const env = await setup();
  let clock = NOW;
  const app = createApp({ db: env.db, storage: env.storage, ai: new MockAIProvider(), projectId: env.projectId, auth: { mode: "session", ...auth }, now: () => clock });

  async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = await app.request(`/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, json: (await res.json()) as any, setCookie: res.headers.get("set-cookie") };
  }
  async function login(username: string, password: string) {
    const r = await call("POST", "/auth/login", { body: { username, password } });
    const cookie = r.setCookie?.split(";")[0];
    return { ...r, cookie };
  }
  return { ...env, app, call, login, setNow: (d: Date) => (clock = d) };
}

describe("passwords", () => {
  it("stores a salted PBKDF2 hash that verifies only the right password", async () => {
    const a = await hashPassword("una clave larga");
    const b = await hashPassword("una clave larga");
    expect(a).toMatch(new RegExp(`^pbkdf2-sha256\\$${PASSWORD_ITERATIONS}\\$`));
    expect(a).not.toBe(b);
    expect(a).not.toContain("una clave larga");
    expect(await verifyPassword("una clave larga", a)).toBe(true);
    expect(await verifyPassword("otra clave", a)).toBe(false);
    expect(await verifyPassword("una clave larga", null)).toBe(false);
    expect(await verifyPassword("x", "basura")).toBe(false);
  });
});

describe("login and sessions", () => {
  it("requires a session for every API route except login/logout", async () => {
    const s = await sessionApp();
    for (const path of ["/session", "/dashboard", "/orders", "/users"]) {
      const r = await s.call("GET", path);
      expect(r.status, path).toBe(401);
      expect(r.json.error).toEqual({ code: "unauthorized", message: "Inicia sesión para continuar." });
    }
    expect((await s.call("POST", "/assistant/messages", { body: { text: "hola" } })).status).toBe(401);
  });

  it("logs juan in with a username, sets a hardened cookie and identifies him as administrator", async () => {
    const s = await sessionApp({ secureCookie: true });
    const r = await s.login("Juan ", DEMO_PASSWORD);
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ name: "Juan Hernández", username: "juan", role: "propietario", isAdmin: true });
    expect(r.setCookie).toMatch(/^cc_session=[\w-]{40,};/);
    expect(r.setCookie).toContain("HttpOnly");
    expect(r.setCookie).toContain("SameSite=Lax");
    expect(r.setCookie).toContain("Secure");
    const session = await s.call("GET", "/session", { cookie: r.cookie });
    expect(session.status).toBe(200);
    expect(session.json.user).toMatchObject({ username: "juan", isAdmin: true });
    // Only the token's hash is stored.
    const rows = await s.db.select().from(t.sessions);
    expect(rows).toHaveLength(1);
    expect(r.cookie).not.toContain(rows[0]!.id);
  });

  it("rejects wrong passwords and unknown users with the same message, and e-mails are not usernames", async () => {
    const s = await sessionApp();
    const wrong = await s.login("juan", "incorrecta");
    const unknown = await s.login("nadie", DEMO_PASSWORD);
    const email = await s.login("juan@casacordoba.local", DEMO_PASSWORD);
    for (const r of [wrong, unknown, email]) {
      expect(r.status).toBe(401);
      expect(r.json.error.message).toBe("Usuario o contraseña incorrectos.");
      expect(r.setCookie).toBeNull();
    }
  });

  it("logout ends the session", async () => {
    const s = await sessionApp();
    const { cookie } = await s.login("marcelo", DEMO_PASSWORD);
    expect((await s.call("GET", "/session", { cookie })).status).toBe(200);
    const out = await s.call("POST", "/auth/logout", { cookie });
    expect(out.status).toBe(200);
    expect(out.setCookie).toContain("Max-Age=0");
    expect((await s.call("GET", "/session", { cookie })).status).toBe(401);
  });

  it("sessions expire after 30 days without use and are extended while in use", async () => {
    const s = await sessionApp();
    const { cookie } = await s.login("juan", DEMO_PASSWORD);
    const day = 24 * 60 * 60 * 1000;
    s.setNow(new Date(NOW.getTime() + 20 * day));
    expect((await s.call("GET", "/session", { cookie })).status).toBe(200); // renews to day 50
    s.setNow(new Date(NOW.getTime() + 45 * day));
    expect((await s.call("GET", "/session", { cookie })).status).toBe(200);
    s.setNow(new Date(NOW.getTime() + 45 * day + 31 * day));
    expect((await s.call("GET", "/session", { cookie })).status).toBe(401);
  });

  it("slows down password guessing: 10 failures lock the username for 15 minutes", async () => {
    const s = await sessionApp();
    for (let i = 0; i < 10; i++) expect((await s.login("juan", `mala-${i}`)).status).toBe(401);
    const locked = await s.login("juan", DEMO_PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.json.error.message).toContain("Demasiados intentos");
    s.setNow(new Date(NOW.getTime() + 16 * 60 * 1000));
    expect((await s.login("juan", DEMO_PASSWORD)).status).toBe(200);
  });
});

describe("user manager", () => {
  it("only the administrator can list and add users", async () => {
    const s = await sessionApp();
    const marcelo = await s.login("marcelo", DEMO_PASSWORD);
    expect((await s.call("GET", "/users", { cookie: marcelo.cookie })).status).toBe(403);
    const denied = await s.call("POST", "/users", { cookie: marcelo.cookie, body: { name: "Intruso", username: "intruso", password: "12345678", role: "otro" } });
    expect(denied.status).toBe(403);
    expect(denied.json.error.message).toBe("Solo el administrador puede gestionar usuarios.");

    const juan = await s.login("juan", DEMO_PASSWORD);
    const list = await s.call("GET", "/users", { cookie: juan.cookie });
    expect(list.status).toBe(200);
    expect(list.json.map((u: { username: string }) => u.username)).toEqual(["juan", "marcelo"]);
    expect(JSON.stringify(list.json)).not.toContain("pbkdf2");
  });

  it("juan adds a user who can then log in", async () => {
    const s = await sessionApp();
    const { cookie } = await s.login("juan", DEMO_PASSWORD);
    const created = await s.call("POST", "/users", { cookie, body: { name: "Lucía Paz", username: "Lucia", password: "obra-segura-2026", role: "ingeniero" } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "Lucía Paz", username: "lucia", role: "ingeniero", isAdmin: false });
    const [row] = await s.db.select().from(t.users).where(eq(t.users.username, "lucia"));
    expect(row!.passwordHash).toMatch(/^pbkdf2-sha256\$/);

    const lucia = await s.login("lucia", "obra-segura-2026");
    expect(lucia.status).toBe(200);
    expect(lucia.json.user).toMatchObject({ name: "Lucía Paz", isAdmin: false });
    expect((await s.call("GET", "/users", { cookie: lucia.cookie })).status).toBe(403);
  });

  it("validates new users in Spanish", async () => {
    const s = await sessionApp();
    const { cookie } = await s.login("juan", DEMO_PASSWORD);
    const add = (body: Record<string, string>) => s.call("POST", "/users", { cookie, body: { name: "Ana", username: "ana", password: "12345678", role: "otro", ...body } });
    expect((await add({ username: "marcelo" })).json.error).toMatchObject({ code: "duplicate", message: "El usuario «marcelo» ya existe." });
    expect((await add({ password: "corta" })).json.error.message).toBe("La contraseña debe tener al menos 8 caracteres.");
    expect((await add({ username: "ana maría" })).json.error.message).toContain("El usuario debe tener");
    expect((await add({ username: "ana@mail.com" })).json.error.message).toContain("El usuario debe tener");
    expect((await add({ name: "  " })).json.error.message).toBe("Falta el nombre.");
    expect((await add({ role: "jefe" })).json.error.message).toBe("Elige un rol válido.");
  });

  it("gives a login to a person already named in records instead of duplicating them", async () => {
    const s = await sessionApp();
    await s.db.insert(t.users).values({ id: "person-1", projectId: s.projectId, name: "Raúl Gómez", role: "otro", canLogin: false, createdAt: NOW.toISOString() });
    const { cookie } = await s.login("juan", DEMO_PASSWORD);
    const created = await s.call("POST", "/users", { cookie, body: { name: "raul gomez", username: "raul", password: "clave-de-raul", role: "otro" } });
    expect(created.json).toMatchObject({ id: "person-1", name: "Raúl Gómez", username: "raul" });
    expect((await s.login("raul", "clave-de-raul")).status).toBe(200);
  });
});

describe("migration 0002", () => {
  it("turns the existing owner into the administrator `juan` and drops e-mails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdo-mig-"));
    const client = createClient({ url: `file:${join(dir, "m.db")}` });
    const apply = async (file: string) => {
      for (const stmt of readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.execute(stmt);
    };
    await apply("0000_init.sql");
    await apply("0001_pending_ai_actions.sql");
    const at = NOW.toISOString();
    await client.execute(`INSERT INTO projects (id, name, created_at) VALUES ('p', 'Casa', '${at}')`);
    await client.execute(`INSERT INTO users (id, project_id, name, role, email, can_login, created_at) VALUES ('owner', 'p', 'Juan', 'propietario', 'jp@example.com', 1, '${at}')`);
    await client.execute(`INSERT INTO users (id, project_id, name, role, email, can_login, created_at) VALUES ('eng', 'p', 'Marcelo', 'ingeniero', 'm@example.com', 1, '${at}')`);
    await client.execute(`INSERT INTO users (id, project_id, name, role, can_login, created_at) VALUES ('ref', 'p', 'Pedro', 'otro', 0, '${at}')`);
    await apply("0002_usernames_and_sessions.sql");
    const rows = (await client.execute("SELECT * FROM users ORDER BY id")).rows;
    expect(rows.map((r) => [r.id, r.username, r.is_admin, r.can_login, r.password_hash])).toEqual([
      ["eng", null, 0, 0, null],
      ["owner", "juan", 1, 1, null],
      ["ref", null, 0, 0, null],
    ]);
    expect(Object.keys(rows[0]!)).not.toContain("email");
  });
});
