import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { DomainError } from "../domain/errors";
import type { Actor } from "../services/context";

// Identity boundary. Local development uses a fixed development user; a
// deployment behind Cloudflare Access can switch AUTH_MODE and map the
// verified Access e-mail header to a user. No passwords live in this app.

export type AuthMode = "dev" | "cloudflare-access";

export interface AuthConfig {
  mode: AuthMode;
  devUserEmail?: string;
}

export async function resolveActor(db: AppDb, projectId: string, config: AuthConfig, headers: Headers): Promise<Actor> {
  let user: typeof t.users.$inferSelect | undefined;
  if (config.mode === "cloudflare-access") {
    const email = headers.get("cf-access-authenticated-user-email");
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
