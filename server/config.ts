import { parseAIProviderId, type AIConfig } from "./ai/factory";
import type { AuthMode } from "./http/auth";

// Environment configuration for the local Node server. A Workers entry would
// build the same shape from its `env` bindings instead.

export interface ServerConfig {
  databaseUrl: string;
  documentsDir: string;
  port: number;
  ai: AIConfig;
  authMode: AuthMode;
  /** `dev` mode only: the user to act as without logging in. */
  devUsername?: string;
  /** Secure (HTTPS-only) session cookie. Off by default locally (http://localhost). */
  secureCookie: boolean;
  projectId?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "file:./data/casa-cordoba.db",
    documentsDir: env.DOCUMENTS_DIR ?? "./data/documents",
    port: Number(env.API_PORT ?? env.PORT ?? 8787),
    // Local development defaults to the deterministic mock; no external AI service is ever called from Node.
    ai: { provider: parseAIProviderId(env.AI_PROVIDER, "mock"), model: env.AI_MODEL || undefined },
    // The login screen is on by default, as in production; `AUTH_MODE=dev` skips it.
    authMode: env.AUTH_MODE === "dev" ? "dev" : "session",
    devUsername: env.DEV_USERNAME || undefined,
    secureCookie: env.SECURE_COOKIE === "true",
    projectId: env.PROJECT_ID || undefined,
  };
}
