import type { Ai, D1Database, ExecutionContext, Fetcher, R2Bucket } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getAIProvider, getDocumentContentExtractor, parseAIProviderId, type AIConfig } from "./ai/factory";
import type { AppDb } from "./db/client";
import * as schema from "./db/schema";
import type { AuthConfig } from "./http/auth";
import { createApp } from "./http/app";
import { R2Storage, UnavailableStorage } from "./storage/r2";

// Cloudflare Workers entry: D1 + R2 + static assets (the Vite build) on one
// origin. The app shell is public (it holds no data) and shows the login
// screen; every `/api` route except login/logout needs a session cookie.
// All responses, assets included, pass through here for the security headers.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DOCUMENTS?: R2Bucket;
  /** mock | cloudflare | disabled (default). */
  AI_PROVIDER?: string;
  /** Workers AI text model (interpretation and answers). AI_MODEL is the older name. */
  AI_TEXT_MODEL?: string;
  AI_MODEL?: string;
  /** Workers AI vision model for photos of receipts; optional. */
  AI_VISION_MODEL?: string;
  AI_MAX_DOCUMENT_MB?: string;
  AI_MAX_MESSAGES_PER_MINUTE?: string;
  /** Workers AI binding (`"ai": { "binding": "AI" }` in wrangler.jsonc). */
  AI?: Ai;
  PROJECT_ID?: string;
  MAX_UPLOAD_MB?: string;
  MAX_UPLOADS_PER_DAY?: string;
  MAX_DOCUMENTS_TOTAL_MB?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "same-origin",
  "permissions-policy": "geolocation=(), payment=(), usb=()",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

function withSecurityHeaders(response: Response): Response {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

type App = ReturnType<typeof createApp>;
let cached: { app: App } | null = null;

async function buildApp(env: Env): Promise<App | null> {
  if (cached) return cached.app;
  const db = drizzle(env.DB, { schema }) as unknown as AppDb;
  const [project] = env.PROJECT_ID
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, env.PROJECT_ID))
    : await db.select().from(schema.projects).limit(1);
  if (!project) return null;
  const auth: AuthConfig = { mode: "session", secureCookie: true };
  const aiConfig: AIConfig = {
    provider: parseAIProviderId(env.AI_PROVIDER, "disabled"),
    model: env.AI_TEXT_MODEL || env.AI_MODEL || undefined,
    visionModel: env.AI_VISION_MODEL || undefined,
    maxDocumentBytes: intEnv(env.AI_MAX_DOCUMENT_MB, 4) * 1024 * 1024,
    cloudflareBinding: env.AI,
  };
  const ai = getAIProvider(aiConfig);
  const app = createApp({
    db,
    storage: env.DOCUMENTS ? new R2Storage(env.DOCUMENTS) : new UnavailableStorage(),
    ai,
    documentExtractor: (bytes) => getDocumentContentExtractor(aiConfig, bytes),
    projectId: project.id,
    auth,
    documentLimits: {
      maxBytes: intEnv(env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
      maxUploadsPerDay: intEnv(env.MAX_UPLOADS_PER_DAY, 100),
      maxTotalBytes: intEnv(env.MAX_DOCUMENTS_TOTAL_MB, 2048) * 1024 * 1024,
    },
    cacheDocumentExtractions: true,
    assistantLimits: { maxMessagesPerMinute: intEnv(env.AI_MAX_MESSAGES_PER_MINUTE, 8), duplicateWindowMs: 20_000 },
  });
  cached = { app };
  return app;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        const app = await buildApp(env);
        if (!app) return withSecurityHeaders(jsonError(503, "not_initialized", "El proyecto todavía no fue inicializado."));
        return withSecurityHeaders(await app.fetch(request));
      } catch (err) {
        console.error(err);
        return withSecurityHeaders(jsonError(500, "internal", "Ocurrió un error inesperado. No se guardó nada; intenta de nuevo."));
      }
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request as never) as unknown as Response);
  },
};
