import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { DomainError } from "../domain/errors";
import type { Actor } from "../services/context";

// Identity boundary. People sign in with a username and password checked
// against a PBKDF2 hash in `users.password_hash`. A successful login creates a
// session: the browser keeps a random token in an HttpOnly cookie and the
// database keeps only its SHA-256. `dev` mode (tests, optional local use)
// skips the login and acts as a fixed user.

export type AuthMode = "dev" | "session";

export interface AuthConfig {
  mode: AuthMode;
  /** `dev` mode: username to act as (default: the first user who can sign in). */
  devUsername?: string;
  /** Send the cookie only over HTTPS (production). Local http development turns it off. */
  secureCookie?: boolean;
}

export interface SessionUser extends Actor {
  username: string;
  isAdmin: boolean;
}

export const ROLES = ["propietario", "ingeniero", "otro"] as const;

// ---------------------------------------------------------------- passwords

/**
 * PBKDF2-SHA256 work factor. Workers Free allows 10 ms of CPU per request, and
 * 10,000 iterations take about 5 ms. The count is stored in each hash, so it can be raised later
 * (e.g. on Workers Paid) without invalidating existing passwords.
 */
export const PASSWORD_ITERATIONS = 10_000;
export const MIN_PASSWORD_LENGTH = 8;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, iter, salt, hash] = (stored ?? "").split("$");
  const iterations = Number(iter);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000 || !salt || !hash) return false;
  try {
    return constantTimeEqual(await pbkdf2(password, unb64(salt), iterations), unb64(hash));
  } catch {
    return false;
  }
}

/** Usernames are lower case: letters, digits, dot, dash, underscore. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export const USERNAME_PATTERN = /^[a-z0-9._-]{2,32}$/;

// ---------------------------------------------------------------- sessions

export const SESSION_COOKIE = "cc_session";
const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Sessions are extended when less than this is left, so active users stay signed in. */
const RENEW_BELOW_MS = (SESSION_DAYS / 2) * DAY_MS;

const FAILED_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The cookie outlives the session on purpose (400 days is the browser cap):
 * the server-side expiry, renewed while the user is active, is what counts.
 */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function sessionCookie(token: string, config: AuthConfig, maxAgeSeconds = COOKIE_MAX_AGE): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`, config.secureCookie ? "Secure" : ""].filter(Boolean).join("; ");
}

export function clearedSessionCookie(config: AuthConfig): string {
  return sessionCookie("", config, 0);
}

export function sessionToken(headers: Headers): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

const unauthorized = () => new DomainError("unauthorized", "Inicia sesión para continuar.");

function toSessionUser(u: typeof t.users.$inferSelect): SessionUser {
  return { userId: u.id, name: u.name, role: u.role, username: u.username ?? "", isAdmin: u.isAdmin };
}

/**
 * Checks a username and password and opens a session. Returns the cookie
 * token. Unknown users and wrong passwords get the same message; repeated
 * failures for a username are refused for 15 minutes.
 */
export async function login(db: AppDb, projectId: string, rawUsername: string, password: string, now: Date): Promise<{ token: string; user: SessionUser }> {
  const username = normalizeUsername(rawUsername);
  const windowStart = new Date(now.getTime() - FAILED_WINDOW_MS).toISOString();
  const [failures] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t.loginAttempts)
    .where(and(eq(t.loginAttempts.username, username), gt(t.loginAttempts.at, windowStart)));
  if ((failures?.n ?? 0) >= MAX_FAILED_ATTEMPTS) throw new DomainError("too_many_attempts", "Demasiados intentos fallidos. Espera 15 minutos y vuelve a intentar.");

  const [user] = username
    ? await db
        .select()
        .from(t.users)
        .where(and(eq(t.users.projectId, projectId), eq(t.users.username, username), eq(t.users.canLogin, true)))
    : [];
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    await db.batch([
      db.insert(t.loginAttempts).values({ id: crypto.randomUUID(), username: username.slice(0, 64), at: now.toISOString() }),
      // Old attempts are not needed once outside the window.
      db.delete(t.loginAttempts).where(lt(t.loginAttempts.at, windowStart)),
    ]);
    throw new DomainError("invalid_credentials", "Usuario o contraseña incorrectos.");
  }

  const token = newToken();
  await db.batch([
    db.insert(t.sessions).values({ id: await sha256Hex(token), userId: user.id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString() }),
    db.delete(t.loginAttempts).where(eq(t.loginAttempts.username, username)),
    db.delete(t.sessions).where(and(eq(t.sessions.userId, user.id), lt(t.sessions.expiresAt, now.toISOString()))),
  ]);
  return { token, user: toSessionUser(user) };
}

export async function logout(db: AppDb, headers: Headers): Promise<void> {
  const token = sessionToken(headers);
  if (token) await db.delete(t.sessions).where(eq(t.sessions.id, await sha256Hex(token)));
}

export async function resolveActor(db: AppDb, projectId: string, config: AuthConfig, headers: Headers, now: Date): Promise<SessionUser> {
  if (config.mode === "dev") {
    const users = await db.select().from(t.users).where(and(eq(t.users.projectId, projectId), eq(t.users.canLogin, true)));
    const user = (config.devUsername && users.find((u) => u.username === config.devUsername)) || users[0];
    if (!user) throw new DomainError("not_found", "No hay un usuario de desarrollo. Ejecuta `npm run db:seed`.");
    return toSessionUser(user);
  }
  const token = sessionToken(headers);
  if (!token) throw unauthorized();
  const id = await sha256Hex(token);
  const [row] = await db
    .select({ user: t.users, expiresAt: t.sessions.expiresAt })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
    .where(and(eq(t.sessions.id, id), eq(t.users.projectId, projectId), eq(t.users.canLogin, true)));
  if (!row || row.expiresAt <= now.toISOString()) throw unauthorized();
  if (Date.parse(row.expiresAt) - now.getTime() < RENEW_BELOW_MS) {
    await db.update(t.sessions).set({ expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString() }).where(eq(t.sessions.id, id));
  }
  return toSessionUser(row.user);
}
