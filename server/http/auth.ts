import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { DomainError } from "../domain/errors";
import type { Actor } from "../services/context";

// Identity boundary. Local development uses a fixed development user; a
// deployment behind Cloudflare Access can switch AUTH_MODE and map the
// verified Access e-mail header to a user; `basic` checks HTTP Basic
// credentials against SHA-256 password hashes held in a Worker secret. No
// passwords live in the database.

export type AuthMode = "dev" | "cloudflare-access" | "basic";

export interface AuthConfig {
  mode: AuthMode;
  devUserEmail?: string;
  /** `basic` mode: lower-case e-mail → hex SHA-256 of the password. */
  basicUsers?: Record<string, string>;
}

export const BASIC_REALM = "Casa Cordoba";

/** Parses `{"email": "sha256hex", …}`; anything malformed yields no users (every login fails closed). */
export function parseBasicUsers(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const users: Record<string, string> = {};
    for (const [email, hash] of Object.entries(parsed)) {
      if (typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash)) users[email.trim().toLowerCase()] = hash.toLowerCase();
    }
    return users;
  } catch {
    return {};
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** E-mail of a valid `Authorization: Basic` header, or null. */
export async function basicAuthEmail(headers: Headers, users: Record<string, string>): Promise<string | null> {
  const header = headers.get("authorization");
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6).trim()), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 1) return null;
  const email = decoded.slice(0, sep).trim().toLowerCase();
  const expected = users[email];
  const actual = await sha256Hex(decoded.slice(sep + 1));
  return expected && constantTimeEqual(actual, expected) ? email : null;
}

export async function resolveActor(db: AppDb, projectId: string, config: AuthConfig, headers: Headers): Promise<Actor> {
  let user: typeof t.users.$inferSelect | undefined;
  if (config.mode === "cloudflare-access" || config.mode === "basic") {
    const email = config.mode === "basic" ? await basicAuthEmail(headers, config.basicUsers ?? {}) : headers.get("cf-access-authenticated-user-email");
    if (!email) throw new DomainError("validation", "No se pudo identificar al usuario.");
    [user] = await db.select().from(t.users).where(and(eq(t.users.projectId, projectId), eq(t.users.email, email.toLowerCase()), eq(t.users.canLogin, true)));
    if (!user) throw new DomainError("not_found", "Tu usuario no tiene acceso a este proyecto.");
  } else {
    const users = await db.select().from(t.users).where(and(eq(t.users.projectId, projectId), eq(t.users.canLogin, true)));
    const wanted = config.devUserEmail?.toLowerCase();
    user = (wanted && users.find((u) => u.email === wanted)) || users[0];
    if (!user) throw new DomainError("not_found", "No hay un usuario de desarrollo. Ejecuta `npm run db:seed`.");
  }
  return { userId: user.id, name: user.name, role: user.role };
}
