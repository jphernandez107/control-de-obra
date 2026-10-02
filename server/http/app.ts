import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppDb } from "../db/client";
import type { AIProvider } from "../ai/provider";
import { DomainError } from "../domain/errors";
import { toMilli } from "../domain/quantity";
import type { DocumentStorage } from "../storage/storage";
import { AssistantService } from "../services/assistant";
import * as commands from "../services/commands";
import { previewComputation, readComputationSheet } from "../services/computation-import";
import type { Actor, CommandContext } from "../services/context";
import { getDocument, MAX_DOCUMENT_BYTES, readDocumentBytes, storeDocument, type DocumentLimits } from "../services/documents";
import * as queries from "../services/queries";
import { resolveActor, type AuthConfig } from "./auth";

// HTTP transport only: parse/validate input, resolve the actor, call a
// service, map errors. No business rules live here. Runs unchanged on Node
// (@hono/node-server) and Cloudflare Workers.

export interface AppDeps {
  db: AppDb;
  storage: DocumentStorage;
  ai: AIProvider;
  projectId: string;
  auth: AuthConfig;
  documentLimits?: DocumentLimits;
  now?: () => Date;
}

type Env = { Variables: { actor: Actor } };

const PaymentMethod = z.enum(["transferencia", "efectivo", "cheque", "otro"]);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida");
/** Money arrives as integer minor units. */
const Minor = z.number().int().nonnegative();
const Positive = z.number().positive();

const CorrectOrderBody = z.object({
  reference: z.string().max(60).nullable().optional(),
  date: DateStr.optional(),
  orderedByName: z.string().max(120).nullable().optional(),
  purchaseMode: z.enum(["cuenta_corriente", "contado"]).optional(),
  notes: z.string().max(2000).nullable().optional(),
  statedTotal: Minor.nullable().optional(),
  items: z.array(z.object({ id: z.string(), quantity: Positive.optional(), unitPrice: Minor.nullable().optional() })).optional(),
  reason: z.string().max(500).nullable().optional(),
});

const DeliveryBody = z.object({
  orderId: z.string(),
  date: DateStr,
  reference: z.string().max(60).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(z.object({ orderItemId: z.string(), quantity: Positive })).min(1),
  documentIds: z.array(z.string()).max(5).optional(),
});

const Allocation = z.object({ orderId: z.string(), amount: Minor.positive() });

const PaymentBody = z.object({
  supplierId: z.string(),
  date: DateStr,
  amount: Minor.positive(),
  method: PaymentMethod.nullable().optional(),
  reference: z.string().max(80).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  allocations: z.array(Allocation).max(50).default([]),
  documentIds: z.array(z.string()).max(5).optional(),
});

const ComputationItemBody = z.object({
  expected: Positive,
  unit: z.string().optional(),
  stage: z.string().max(120).nullable().optional(),
  wastePct: z.number().min(0).max(100).optional(),
  notes: z.string().max(1000).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
});

const ComputationImportBody = z.object({
  documentId: z.string().nullable().optional(),
  rows: z
    .array(
      z.object({
        materialId: z.string().nullable(),
        name: z.string().min(1).max(200),
        unitCode: z.string(),
        expected: Positive,
        stage: z.string().max(120).nullable().optional(),
        wastePct: z.number().min(0).max(100).optional(),
      }),
    )
    .min(1)
    .max(500),
});

// Proposals are application-shaped; they are re-validated and re-resolved by the services.
const InterpretationBody = z.object({ interpretation: z.object({ kind: z.enum(["order", "delivery", "payment"]) }).passthrough() });

function milli(value: number, label: string): number {
  const m = toMilli(value);
  if (m === null || m <= 0) throw new DomainError("invalid_quantity", `La cantidad de ${label} no es válida.`);
  return m;
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new DomainError("validation", "El cuerpo de la solicitud no es JSON válido.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new DomainError("validation", `Datos inválidos${first ? ` (${first.path.join(".") || "solicitud"}: ${first.message})` : ""}.`, parsed.error.issues);
  }
  return parsed.data;
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const qctx = { db: deps.db, projectId: deps.projectId, now };
  const assistant = new AssistantService({ db: deps.db, projectId: deps.projectId, provider: deps.ai, storage: deps.storage, now });
  const cmd = (c: Context<Env>, source: CommandContext["source"] = "manual"): CommandContext => ({ db: deps.db, projectId: deps.projectId, actor: c.get("actor"), source, now });

  const app = new Hono<Env>().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    console.error(err);
    return c.json({ error: { code: "internal", message: "Ocurrió un error inesperado. No se guardó nada; intenta de nuevo." } }, 500);
  });

  app.use("*", async (c, next) => {
    c.set("actor", await resolveActor(deps.db, deps.projectId, deps.auth, c.req.raw.headers));
    await next();
  });

  const jsonLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: { code: "validation", message: "La solicitud es demasiado grande." } }, 413),
  });
  app.use("*", (c, next) => (c.req.path === "/api/documents" ? next() : jsonLimit(c, next)));

  // ---------------------------------------------------------------- session
  app.get("/session", async (c) => {
    const actor = c.get("actor");
    return c.json({ today: await queries.projectToday(qctx), user: actor, ai: { provider: deps.ai.name, model: deps.ai.model ?? null } });
  });

  // ---------------------------------------------------------------- read models
  app.get("/dashboard", async (c) => c.json(await queries.dashboard(qctx)));
  app.get("/orders", async (c) => c.json(await queries.ordersOverview(qctx)));
  app.get("/orders/:id", async (c) => c.json(await queries.orderDetail(qctx, c.req.param("id"))));
  app.get("/suppliers", async (c) => c.json(await queries.suppliersOverview(qctx)));
  app.get("/suppliers/options", async (c) => c.json(await queries.supplierOptions(qctx)));
  app.get("/suppliers/:id", async (c) => c.json(await queries.supplierDetail(qctx, c.req.param("id"))));
  app.get("/materials", async (c) => c.json(await queries.materialsOverview(qctx)));
  app.get("/materials/options", async (c) => c.json(await queries.materialOptions(qctx)));
  app.get("/materials/:id", async (c) => c.json(await queries.materialDetail(qctx, c.req.param("id"))));
  app.get("/units", async (c) => c.json(await queries.unitOptions(qctx)));
  app.get("/activity", async (c) => {
    const q = c.req.query();
    const kinds = c.req.queries("kind") as never;
    return c.json(await queries.activity(qctx, { search: q.search || undefined, supplierId: q.supplierId || undefined, from: q.from || undefined, to: q.to || undefined, kinds }));
  });

  // ---------------------------------------------------------------- orders
  app.patch("/orders/:id", async (c) => {
    const b = await body(c, CorrectOrderBody);
    await commands.correctOrder(cmd(c), c.req.param("id"), {
      reference: b.reference,
      date: b.date,
      orderedByName: b.orderedByName,
      purchaseMode: b.purchaseMode,
      notes: b.notes,
      statedTotalMinor: b.statedTotal,
      items: b.items?.map((i) => ({ id: i.id, quantityMilli: i.quantity === undefined ? undefined : milli(i.quantity, "un material"), unitPriceMinor: i.unitPrice })),
      reason: b.reason,
    });
    return c.json(await queries.orderDetail(qctx, c.req.param("id")));
  });
  app.post("/orders/:id/void", async (c) => {
    const b = await body(c, z.object({ reason: z.string().max(500).optional() }));
    await commands.voidRecord(cmd(c), "order", c.req.param("id"), b.reason);
    return c.json({ ok: true });
  });
  app.post("/orders/:id/documents", async (c) => {
    const b = await body(c, z.object({ documentId: z.string() }));
    await commands.attachDocument(cmd(c), { documentId: b.documentId, orderId: c.req.param("id") });
    return c.json(await queries.orderDetail(qctx, c.req.param("id")));
  });

  // ---------------------------------------------------------------- deliveries
  app.post("/deliveries", async (c) => {
    const b = await body(c, DeliveryBody);
    const result = await commands.registerDelivery(cmd(c), {
      orderId: b.orderId,
      date: b.date,
      reference: b.reference,
      notes: b.notes,
      items: b.items.map((i) => ({ orderItemId: i.orderItemId, quantityMilli: milli(i.quantity, "la entrega") })),
      documentIds: b.documentIds,
    });
    return c.json(result, 201);
  });
  app.post("/deliveries/:id/void", async (c) => {
    const b = await body(c, z.object({ reason: z.string().max(500).optional() }));
    await commands.voidRecord(cmd(c), "delivery", c.req.param("id"), b.reason);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- payments
  app.post("/payments", async (c) => {
    const b = await body(c, PaymentBody);
    const result = await commands.createPayment(cmd(c), {
      supplierId: b.supplierId,
      date: b.date,
      amountMinor: b.amount,
      method: b.method,
      reference: b.reference,
      notes: b.notes,
      allocations: b.allocations.map((a) => ({ orderId: a.orderId, amountMinor: a.amount })),
      documentIds: b.documentIds,
    });
    return c.json(result, 201);
  });
  app.post("/payments/:id/allocations", async (c) => {
    const b = await body(c, z.object({ allocations: z.array(Allocation).min(1).max(50) }));
    const result = await commands.allocatePayment(
      cmd(c),
      c.req.param("id"),
      b.allocations.map((a) => ({ orderId: a.orderId, amountMinor: a.amount })),
    );
    return c.json(result, 201);
  });
  app.post("/payments/:id/void", async (c) => {
    const b = await body(c, z.object({ reason: z.string().max(500).optional() }));
    await commands.voidRecord(cmd(c), "payment", c.req.param("id"), b.reason);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- computation
  app.put("/materials/:id/computation", async (c) => {
    const b = await body(c, ComputationItemBody);
    const result = await commands.setComputationItems(
      cmd(c),
      [{ material: { id: c.req.param("id") }, expectedQuantityMilli: milli(b.expected, "cómputo"), unit: b.unit, stage: b.stage, wasteBasisPoints: b.wastePct === undefined ? undefined : Math.round(b.wastePct * 100), notes: b.notes }],
      { reason: b.reason },
    );
    return c.json(result);
  });
  app.post("/materials/:id/reviewed", async (c) => {
    await commands.markComputationReviewed(cmd(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/computation/preview", async (c) => {
    const b = await body(c, z.object({ documentId: z.string() }));
    const doc = await getDocument(deps.db, deps.projectId, b.documentId);
    const rows = await readComputationSheet(doc.fileName, doc.mimeType, await readDocumentBytes(deps.storage, doc));
    return c.json({ documentId: doc.id, fileName: doc.fileName, rows: previewComputation(await queries.ledgerFor(qctx), rows) });
  });
  app.post("/computation/import", async (c) => {
    const b = await body(c, ComputationImportBody);
    const result = await commands.setComputationItems(
      cmd(c),
      b.rows.map((r) => ({
        material: r.materialId ? { id: r.materialId } : { newName: r.name, unit: r.unitCode },
        expectedQuantityMilli: milli(r.expected, r.name),
        unit: r.unitCode,
        stage: r.stage ?? null,
        wasteBasisPoints: r.wastePct ? Math.round(r.wastePct * 100) : 0,
      })),
      { sourceDocumentId: b.documentId ?? null, importLabel: "planilla importada" },
    );
    return c.json(result);
  });

  // ---------------------------------------------------------------- documents
  const uploadLimit = bodyLimit({
    // Multipart framing adds a little on top of the file itself.
    maxSize: (deps.documentLimits?.maxBytes ?? MAX_DOCUMENT_BYTES) + 64 * 1024,
    onError: (c) => c.json({ error: { code: "unsupported_document", message: "El archivo es demasiado grande." } }, 413),
  });
  app.post("/documents", uploadLimit, async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new DomainError("validation", "Falta el archivo.");
    const kind = typeof form.kind === "string" && ["order_proof", "delivery_proof", "payment_proof", "computation", "other"].includes(form.kind) ? (form.kind as commands.DocumentKindCode) : "other";
    const row = await storeDocument(
      { db: deps.db, storage: deps.storage, projectId: deps.projectId, userId: c.get("actor").userId, now, limits: deps.documentLimits },
      { fileName: file.name || "documento", mimeType: file.type, data: new Uint8Array(await file.arrayBuffer()), kind },
    );
    return c.json({ id: row.id, fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes, url: `/api/documents/${row.id}/file` }, 201);
  });
  app.get("/documents/:id/file", async (c) => {
    const doc = await getDocument(deps.db, deps.projectId, c.req.param("id"));
    const data = await readDocumentBytes(deps.storage, doc);
    const disposition = c.req.query("download") ? "attachment" : "inline";
    return new Response(data as unknown as ArrayBuffer, {
      headers: {
        "content-type": doc.mimeType,
        "content-length": String(data.byteLength),
        "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // ---------------------------------------------------------------- assistant
  app.get("/assistant/thread", async (c) => c.json(await assistant.thread(c.req.query("conversationId") || undefined)));
  app.get("/assistant/conversations", async (c) => c.json(await assistant.conversations()));
  app.post("/assistant/conversations", async (c) => c.json(await assistant.newConversation(c.get("actor")), 201));
  app.post("/assistant/messages", async (c) => {
    const b = await body(c, z.object({ conversationId: z.string().nullable().optional(), text: z.string().max(4000).optional(), documentIds: z.array(z.string()).max(5).optional() }));
    return c.json(await assistant.send(c.get("actor"), { conversationId: b.conversationId ?? undefined, text: b.text, documentIds: b.documentIds }));
  });
  app.post("/assistant/choices", async (c) => {
    const b = await body(
      c,
      z.object({
        conversationId: z.string(),
        choiceId: z.string(),
        optionId: z.string(),
        label: z.string().max(200),
        context: z.object({ supplierId: z.string(), amount: Minor.positive(), date: DateStr.optional(), method: PaymentMethod.optional() }),
      }),
    );
    return c.json(await assistant.choose(c.get("actor"), b));
  });
  app.post("/assistant/interpretations/:id/revise", async (c) => {
    const b = await body(c, InterpretationBody);
    return c.json({ interpretation: await assistant.revise(c.req.param("id"), b.interpretation as never) });
  });
  app.post("/assistant/interpretations/:id/confirm", async (c) => {
    const b = await body(c, InterpretationBody);
    return c.json(await assistant.confirm(c.get("actor"), c.req.param("id"), b.interpretation as never));
  });
  app.post("/assistant/interpretations/:id/cancel", async (c) => {
    await assistant.cancel(c.get("actor"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/assistant/undo", async (c) => {
    const b = await body(c, z.object({ recordId: z.string(), conversationId: z.string().nullable().optional() }));
    return c.json(await assistant.undo(c.get("actor"), { recordId: b.recordId, conversationId: b.conversationId ?? undefined }));
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Ruta no encontrada" } }, 404));
  return app;
}
