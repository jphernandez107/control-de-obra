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
  devUserEmail?: string;
  projectId?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "file:./data/casa-cordoba.db",
    documentsDir: env.DOCUMENTS_DIR ?? "./data/documents",
    port: Number(env.API_PORT ?? env.PORT ?? 8787),
    // Local development defaults to the deterministic mock; no external AI service is ever called from Node.
    ai: { provider: parseAIProviderId(env.AI_PROVIDER, "mock"), model: env.AI_MODEL || undefined },
    authMode: env.AUTH_MODE === "cloudflare-access" ? "cloudflare-access" : "dev",
    devUserEmail: env.DEV_USER_EMAIL || undefined,
    projectId: env.PROJECT_ID || undefined,
  };
}
