import { parseProviderSetting, type AIProviderSetting } from "./ai/factory";
import type { AuthMode } from "./http/auth";

// Environment configuration for the local Node server. A Workers entry would
// build the same shape from its `env` bindings instead.

export interface ServerConfig {
  databaseUrl: string;
  documentsDir: string;
  port: number;
  aiProvider: AIProviderSetting;
  anthropicApiKey?: string;
  aiModel: string;
  aiEffort: "low" | "medium" | "high" | "xhigh" | "max";
  authMode: AuthMode;
  devUserEmail?: string;
  projectId?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const effort = (env.AI_EFFORT ?? "low").toLowerCase();
  return {
    databaseUrl: env.DATABASE_URL ?? "file:./data/casa-cordoba.db",
    documentsDir: env.DOCUMENTS_DIR ?? "./data/documents",
    port: Number(env.API_PORT ?? env.PORT ?? 8787),
    aiProvider: parseProviderSetting(env.AI_PROVIDER, "auto"),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    aiModel: env.AI_MODEL || "claude-opus-5-5",
    aiEffort: (["low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : "low") as ServerConfig["aiEffort"],
    authMode: env.AUTH_MODE === "cloudflare-access" ? "cloudflare-access" : "dev",
    devUserEmail: env.DEV_USER_EMAIL || undefined,
    projectId: env.PROJECT_ID || undefined,
  };
}
