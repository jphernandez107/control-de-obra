import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { DomainError } from "../domain/errors";
import { normalizeText } from "../domain/text";
import { hashPassword, MIN_PASSWORD_LENGTH, normalizeUsername, ROLES, USERNAME_PATTERN } from "../http/auth";
import { newId } from "./context";

// People who can sign in. Only an administrator adds them; passwords are
// typed by the administrator and stored as PBKDF2 hashes.

export interface UserAccount {
  id: string;
  name: string;
  username: string;
  role: string;
  isAdmin: boolean;
  createdAt: string;
}

export const NewUserSchema = z.object({
  name: z.string().trim().min(1, "Falta el nombre.").max(120),
  username: z.string().transform(normalizeUsername).pipe(z.string().regex(USERNAME_PATTERN, "El usuario debe tener entre 2 y 32 letras minúsculas, números, puntos o guiones.")),
  password: z.string().min(MIN_PASSWORD_LENGTH, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`).max(200),
  role: z.enum(ROLES, "Elige un rol válido."),
});

export interface NewUser {
  name: string;
  username: string;
  password: string;
  role: string;
}

export async function listUsers(db: AppDb, projectId: string): Promise<UserAccount[]> {
  const rows = await db
    .select()
    .from(t.users)
    .where(and(eq(t.users.projectId, projectId), eq(t.users.canLogin, true)))
    .orderBy(asc(t.users.createdAt), asc(t.users.name));
  return rows.map((u) => ({ id: u.id, name: u.name, username: u.username ?? "", role: u.role, isAdmin: u.isAdmin, createdAt: u.createdAt }));
}

/**
 * Gives someone a login. A person already named in records (e.g. "pedido por
 * Marcelo") gets the login on that same row, so their history stays linked.
 */
export async function createUser(db: AppDb, projectId: string, input: NewUser, now: Date): Promise<UserAccount> {
  const parsed = NewUserSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Datos inválidos.");
  const { name, username, password, role } = parsed.data;

  const [taken] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.username, username));
  if (taken) throw new DomainError("duplicate", `El usuario «${username}» ya existe.`);

  const people = await db.select().from(t.users).where(eq(t.users.projectId, projectId));
  const existing = people.find((p) => !p.username && normalizeText(p.name) === normalizeText(name));
  const passwordHash = await hashPassword(password);

  if (existing) {
    await db.update(t.users).set({ username, passwordHash, role, canLogin: true }).where(eq(t.users.id, existing.id));
    return { id: existing.id, name: existing.name, username, role, isAdmin: existing.isAdmin, createdAt: existing.createdAt };
  }
  const id = newId();
  const createdAt = now.toISOString();
  await db.insert(t.users).values({ id, projectId, name, role, username, passwordHash, canLogin: true, isAdmin: false, createdAt });
  return { id, name, username, role, isAdmin: false, createdAt };
}
