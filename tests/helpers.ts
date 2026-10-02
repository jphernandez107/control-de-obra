import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAIProvider } from "../server/ai/mock";
import type { DocumentBytesSource, DocumentContentExtractor } from "../server/ai/document-content";
import type { AIProvider } from "../server/ai/provider";
import { migrateDatabase, openDatabase } from "../server/db/node";
import { createApp } from "../server/http/app";
import { seedDatabase } from "../server/seed";
import { MemoryStorage } from "../server/storage/storage";
import type { AssistantBlock, ChatMessage, ConfirmResponse, Interpretation } from "../src/domain/assistant";

// Each test gets its own SQLite file (real migrations, real constraints) and the
// HTTP app as the UI uses it.

export const NOW = new Date("2026-10-02T13:00:00.000Z");

export async function setup(options: { empty?: boolean; bare?: boolean; ai?: AIProvider; extractor?: (bytes: DocumentBytesSource) => DocumentContentExtractor } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cdo-test-"));
  const { db, client } = await openDatabase(`file:${join(dir, "test.db")}`);
  await migrateDatabase(db);
  const storage = new MemoryStorage();
  const { projectId } = await seedDatabase(db, storage, { empty: options.empty, bare: options.bare, now: NOW });
  const app = createApp({ db, storage, ai: options.ai ?? new MockAIProvider(), documentExtractor: options.extractor, projectId, auth: { mode: "dev" }, now: () => NOW });

  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await app.request(`/api${path}`, {
      method,
      headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as T };
  }
  const get = <T = any>(path: string) => call<T>("GET", path).then((r) => r.json);
  const post = <T = any>(path: string, body?: unknown) => call<T>("POST", path, body ?? {});

  /** Sends a chat message and returns the assistant reply. */
  async function say(text: string, documentIds?: string[], conversationId?: string) {
    const r = await post<{ conversationId: string; reply: ChatMessage }>("/assistant/messages", { text, documentIds, conversationId });
    if (r.status !== 200) throw new Error(`say failed ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
  function proposalOf(reply: ChatMessage) {
    const block = reply.blocks?.find((b): b is Extract<AssistantBlock, { type: "interpretation" }> => b.type === "interpretation");
    if (!block) throw new Error(`No proposal in: ${JSON.stringify(reply.blocks)}`);
    return block;
  }
  async function confirm(id: string, interpretation: Interpretation) {
    return post<ConfirmResponse>(`/assistant/interpretations/${id}/confirm`, { interpretation });
  }
  async function upload(fileName: string, data: Uint8Array, type: string) {
    const form = new FormData();
    form.append("file", new File([data as unknown as ArrayBuffer], fileName, { type }));
    const r = await call<{ id: string }>("POST", "/documents", form);
    if (r.status !== 201) throw new Error(`upload failed ${JSON.stringify(r.json)}`);
    return r.json.id;
  }
  async function orderByNumber(number: string) {
    const overview = await get("/orders");
    const summary = overview.orders.find((o: { number: string }) => o.number === number);
    if (!summary) throw new Error(`Pedido ${number} no encontrado`);
    return get(`/orders/${summary.id}`);
  }
  async function supplierByName(name: string) {
    const overview = await get("/suppliers");
    const s = overview.suppliers.find((x: { name: string }) => x.name === name);
    return get(`/suppliers/${s.id}`);
  }
  return { db, client, app, storage, projectId, call, get, post, say, proposalOf, confirm, upload, orderByNumber, supplierByName };
}

export const pesos = (n: number) => Math.round(n * 100);
