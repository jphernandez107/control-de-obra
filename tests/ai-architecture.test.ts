import { describe, expect, it } from "vitest";
import { CloudflareAIProvider } from "../server/ai/cloudflare";
import { DisabledAIProvider } from "../server/ai/disabled";
import { FixtureDocumentContentExtractor, LocalDocumentContentExtractor } from "../server/ai/document-content";
import { AIError } from "../server/ai/errors";
import { getAIProvider, parseAIProviderId } from "../server/ai/factory";
import { interpretText, MockAIProvider } from "../server/ai/mock";
import { projectQueryTools } from "../server/ai/project-queries";
import type { AIProvider } from "../server/ai/provider";
import { interpretationJsonSchema, parseInterpretationResult } from "../server/ai/schemas";
import { matchMaterial, matchSupplier, rankOrders } from "../server/domain/matching";
import * as t from "../server/db/schema";
import type { AssistantBlock, DeliveryInterpretation, PaymentInterpretation } from "../src/domain/assistant";
import { pesos, setup } from "./helpers";

const SUPPLIERS = ["Hierros Córdoba", "Sanitarios del Centro", "Corralón San Martín"];

function blocksOf(reply: { blocks?: AssistantBlock[] }) {
  return reply.blocks ?? [];
}
function textOf(reply: { blocks?: AssistantBlock[] }) {
  return blocksOf(reply)
    .filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

describe("AI contract validation", () => {
  it("accepts a well-formed interpretation and turns empty strings into null", () => {
    const r = parseInterpretationResult({
      interpretation: { intent: "pay_order_balance", confidence: 0.9, note: "", orderReference: " 38 ", supplier: "", date: null, paymentMethod: null, paymentReference: null },
      document: null,
    });
    expect(r.interpretation).toMatchObject({ intent: "pay_order_balance", orderReference: "38", supplier: null, note: null });
  });

  it.each([
    ["unknown intent", { intent: "create_invoice", confidence: 1, note: null }],
    ["amount as text", { intent: "create_supplier_payment", confidence: 1, note: null, supplier: "X", amount: "500000", currency: "ARS", date: null, paymentMethod: null, paymentReference: null, toCurrentAccount: true, orderReference: null, allocations: [] }],
    ["negative quantity", { intent: "register_delivery", confidence: 1, note: null, orderReference: "38", supplier: null, deliveryReference: null, date: null, items: [{ material: "Ø12", quantity: -3, unit: null }] }],
    ["bad date", { intent: "complete_order_delivery", confidence: 1, note: null, orderReference: "38", supplier: null, deliveryReference: null, date: "02/10/2026" }],
    ["confidence out of range", { intent: "unknown", confidence: 7, note: null }],
    ["missing fields", { intent: "create_order", confidence: 1, note: null }],
  ])("rejects malformed output: %s", (_label, interpretation) => {
    expect(() => parseInterpretationResult({ interpretation, document: null })).toThrowError(AIError);
    try {
      parseInterpretationResult({ interpretation, document: null });
    } catch (e) {
      expect((e as AIError).code).toBe("AI_INVALID_RESPONSE");
    }
  });

  it("exposes JSON schemas for a future model adapter and tool calling", () => {
    expect(JSON.stringify(interpretationJsonSchema())).toContain("pay_order_balance");
    expect(JSON.stringify(interpretationJsonSchema())).not.toMatch(/factura|invoice/i);
    expect(projectQueryTools().map((t) => t.name)).toEqual([
      "get_supplier_summary",
      "list_supplier_balances",
      "get_order_summary",
      "list_orders_pending_delivery",
      "list_delivered_unpaid_orders",
      "get_material_summary",
      "get_computation_variance",
      "list_unallocated_payments",
      "search_materials",
      "get_material_order_summary",
      "get_material_delivery_summary",
      "get_material_history",
      "get_order_items",
      "search_order_items",
      "get_computation_comparison",
    ]);
  });

  it("never lets malformed provider output reach a proposal", async () => {
    const broken: AIProvider = {
      ...new MockAIProvider(),
      id: "mock",
      name: "roto",
      configured: true,
      interpret: async () => ({ interpretation: { intent: "create_order", confidence: 1, note: null, items: "20 barras" }, document: null }) as never,
      analyzeDocument: async () => ({}) as never,
      answer: async () => ({ text: "" }),
    };
    const env = await setup({ ai: broken });
    const r = await env.say("Marcelo pidió 20 barras del 12 a Hierros Córdoba.");
    expect(blocksOf(r.reply)[0]).toMatchObject({ type: "ai_error", code: "AI_INVALID_RESPONSE" });
    expect(await env.db.select().from(t.aiInterpretations)).toHaveLength(0);
  });
});

describe("provider configuration and error states", () => {
  it("understands mock, cloudflare and disabled", () => {
    expect(parseAIProviderId("cloudflare", "mock")).toBe("cloudflare");
    expect(parseAIProviderId("anthropic", "disabled")).toBe("disabled");
    expect(getAIProvider({ provider: "mock" }).configured).toBe(true);
    expect(getAIProvider({ provider: "cloudflare" })).toBeInstanceOf(CloudflareAIProvider);
    expect(getAIProvider({ provider: "disabled" }).configured).toBe(false);
  });

  it("explains in Spanish when AI is not configured, and the rest keeps working", async () => {
    for (const ai of [new DisabledAIProvider(), new CloudflareAIProvider()]) {
      const env = await setup({ ai });
      expect((await env.get("/session")).ai).toMatchObject({ configured: false });
      const r = await env.say("Pagamos completo el pedido 38.");
      expect(blocksOf(r.reply)[0]).toMatchObject({ type: "ai_error", code: "AI_NOT_CONFIGURED", message: expect.stringContaining("La función de IA todavía no está configurada.") });
      expect((await env.get("/suppliers")).suppliers.length).toBeGreaterThan(0);
    }
  });

  it("maps quota and outages to their own messages", async () => {
    const failing = (code: "AI_QUOTA_EXCEEDED" | "AI_PROVIDER_UNAVAILABLE"): AIProvider => ({
      id: "cloudflare",
      name: "falla",
      configured: true,
      interpret: async () => {
        throw new AIError(code);
      },
      analyzeDocument: async () => {
        throw new AIError(code);
      },
      answer: async () => {
        throw new AIError(code);
      },
    });
    const quota = await setup({ ai: failing("AI_QUOTA_EXCEEDED") });
    expect(blocksOf((await quota.say("Llegaron 5 barras del 10")).reply)[0]).toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
    const down = await setup({ ai: failing("AI_PROVIDER_UNAVAILABLE") });
    const reply = (await down.say("Llegaron 5 barras del 10")).reply;
    expect(blocksOf(reply)[0]).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", message: expect.stringContaining("El resto de la aplicación sigue funcionando") });
  });
});

describe("matching", () => {
  const suppliers = [
    { id: "s1", name: "Hierros Córdoba", aliases: ["la de hierros"] },
    { id: "s2", name: "Sanitarios del Centro", aliases: [] },
  ];
  it("matches suppliers exactly, by alias and fuzzily, without inventing", () => {
    expect(matchSupplier("hierros cordoba", suppliers)).toMatchObject({ status: "matched", best: { id: "s1" } });
    expect(matchSupplier("la de hierros", suppliers)).toMatchObject({ status: "matched", best: { id: "s1" } });
    const fuzzy = matchSupplier("Hierros", suppliers);
    expect(fuzzy.best?.id).toBe("s1");
    expect(matchSupplier("Ferretería Norte", suppliers).status).toBe("new");
  });

  // No aliases on purpose: the heuristics alone must resolve these wordings.
  const materials = [
    { id: "a12", name: "Acero Ø12", shortName: "Ø12", aliases: [], baseUnit: "barra" },
    { id: "a10", name: "Acero Ø10", shortName: "Ø10", aliases: [], baseUnit: "barra" },
    { id: "cem", name: "Cemento portland 50 kg", shortName: "cemento", aliases: [], baseUnit: "bolsa" },
  ];
  it.each(["hierro del 12", "acero del 12", "barra Ø12", "acero 12 mm", "Ø12", "barras del 12"])("resolves «%s» to Acero Ø12", (mention) => {
    expect(matchMaterial(mention, materials)).toMatchObject({ status: "matched", best: { id: "a12" } });
  });
  it("does not confuse diameters and returns candidates when unsure", () => {
    expect(matchMaterial("hierro del 10", materials).best?.id).toBe("a10");
    const vague = matchMaterial("acero", materials);
    expect(vague.status).not.toBe("matched");
    expect(vague.candidates.length).toBeGreaterThan(1);
    expect(matchMaterial("pintura látex", materials).status).toBe("new");
  });

  it("ranks orders by evidence and never picks close candidates as matched", () => {
    const base = { internalNumber: 1, reference: null, supplierId: "s1" };
    const orders = [
      { ...base, id: "o1", orderDate: "2026-09-01", materialIds: ["a10"], openMaterialIds: ["a10"], remainingByMaterial: { a10: 5000 } },
      { ...base, id: "o2", orderDate: "2026-09-20", materialIds: ["a10", "a12"], openMaterialIds: ["a10", "a12"], remainingByMaterial: { a10: 30000, a12: 20000 } },
    ];
    const exact = rankOrders({ materials: [{ materialId: "a10", quantityMilli: 5000 }] }, orders);
    expect(exact).toMatchObject({ status: "suggested", best: { id: "o1" } });
    const byRef = rankOrders({ reference: "38" }, [{ ...orders[0]!, reference: "38" }, orders[1]!]);
    expect(byRef).toMatchObject({ status: "matched", best: { id: "o1" } });
  });
});

describe("deterministic read-only queries", () => {
  it("answers from the database and writes nothing", async () => {
    const env = await setup();
    const before = (await env.get("/activity")).length;
    const supplier = await env.get("/queries/get_supplier_summary?supplier=hierros");
    expect(supplier.data).toMatchObject({ supplier: "Hierros Córdoba", outstandingBalanceMinor: pesos(2_982_340), unallocatedPaidMinor: pesos(500_000) });
    const order = await env.get("/queries/get_order_summary?order=381");
    expect(order.data.financial).toMatchObject({ remainingBalanceMinor: pesos(882_340), status: "parcial" });
    expect(order.data.delivery.lines.find((l: { material: string }) => l.material === "Acero Ø10")).toMatchObject({ ordered: 30, delivered: 25, remaining: 5 });
    const unpaid = await env.get("/queries/list_delivered_unpaid_orders");
    expect(unpaid.data.orders.map((o: { number: string }) => o.number)).toContain("41");
    const steel = await env.get("/queries/get_material_summary?material=hierro%20del%2012");
    expect(steel.data).toMatchObject({ material: "Acero Ø12", status: "supera" });
    expect(steel.data.variance).toBeGreaterThan(0);
    const unallocated = await env.get("/queries/list_unallocated_payments");
    expect(unallocated.data.totalMinor).toBe(pesos(500_000));
    const ambiguous = await env.get("/queries/get_material_summary?material=acero");
    expect(ambiguous.status).toBe("ambiguous");
    expect((await env.get("/activity")).length).toBe(before);
  });

  it("follows up on the previous order, and asks when the reference is ambiguous", async () => {
    const env = await setup();
    const first = await env.say("¿Cómo viene el pedido 38?");
    expect(textOf(first.reply)).toContain("pedido 38");
    const follow = await env.say("¿Y cuánto falta pagar?", undefined, first.conversationId);
    expect(textOf(follow.reply)).toContain("falta pagar $1.482.340");
    const list = await env.say("¿Qué pedidos siguen pendientes de entrega?", undefined, first.conversationId);
    expect(blocksOf(list.reply).some((b) => b.type === "pending_deliveries")).toBe(true);
    const unclear = await env.say("¿Y cuánto falta pagar?", undefined, first.conversationId);
    expect(textOf(unclear.reply)).toContain("¿De qué pedido?");
  });

  it("uses the conversation focus for «todo lo pendiente» and «pagalo completo»", async () => {
    const env = await setup();
    const first = await env.say("¿Cómo viene el pedido 381?");
    const delivery = await env.say("Llegó todo lo pendiente.", undefined, first.conversationId);
    const p = env.proposalOf(delivery.reply).interpretation as DeliveryInterpretation;
    expect(p).toMatchObject({ orderNumber: "381", completesOrder: true });
    expect(p.items.map((i) => [i.material, i.now])).toEqual([["Acero Ø10", 5]]);
    const pay = await env.say("Pagalo completo.", undefined, first.conversationId);
    expect((env.proposalOf(pay.reply).interpretation as PaymentInterpretation).amount).toBe(pesos(882_340));
  });

  it("asks instead of guessing when information is missing", async () => {
    const env = await setup();
    const r = await env.say("Pagamos a Hierros Córdoba.");
    expect(textOf(r.reply)).toContain("¿De cuánto fue el pago a Hierros Córdoba?");
    expect(blocksOf(r.reply).some((b) => b.type === "interpretation")).toBe(false);
    expect(interpretText("Pagamos completo.", "2026-10-02", SUPPLIERS)).toMatchObject({ intent: "pay_order_balance", orderReference: null });
    const noOrder = await env.say("Pagamos completo.");
    expect(textOf(noOrder.reply)).toContain("¿Qué pedido se pagó completo?");
  });
});

describe("pending actions, revalidation and audit", () => {
  it("recalculates on confirm and refuses a stale payment amount", async () => {
    const env = await setup();
    const r = await env.say("Pagamos completo el pedido 381.");
    const block = env.proposalOf(r.reply);
    const proposal = block.interpretation as PaymentInterpretation;
    expect(proposal).toMatchObject({ amount: pesos(882_340), paysOrderBalance: true, validation: { state: "ready" } });
    // Someone pays part of it from the supplier screen meanwhile.
    const order = await env.orderByNumber("381");
    const manual = await env.post("/payments", { supplierId: order.supplier.id, date: "2026-10-02", amount: pesos(100_000), method: "efectivo", allocations: [{ orderId: order.id, amount: pesos(100_000) }] });
    expect(manual.status).toBe(201);
    const stale = await env.confirm(block.id, proposal);
    expect(stale.status).toBe(409);
    expect((stale.json as any).error).toMatchObject({ code: "stale_proposal", interpretation: { amount: pesos(782_340) } });
    const ok = await env.confirm(block.id, (stale.json as any).error.interpretation);
    expect(ok.status).toBe(200);
    expect((await env.orderByNumber("381")).payment.status).toBe("pagado");
  });

  it("refuses a stale «todo lo pendiente» delivery", async () => {
    const env = await setup();
    const r = await env.say("Se entregó todo lo pendiente del pedido 38.");
    const block = env.proposalOf(r.reply);
    const order = await env.orderByNumber("38");
    await env.post("/deliveries", { orderId: order.id, date: "2026-10-02", items: [{ orderItemId: order.lines[0].id, quantity: 20 }] });
    const stale = await env.confirm(block.id, block.interpretation);
    expect(stale.status).toBe(409);
    const refreshed = (stale.json as any).error.interpretation as DeliveryInterpretation;
    expect(refreshed.items.map((i) => [i.material, i.now])).toEqual([["Acero Ø10", 30]]);
    expect((await env.confirm(block.id, refreshed)).status).toBe(200);
  });

  it("blocks confirmation while validation fails and marks AI-origin audit rows", async () => {
    const env = await setup();
    const r = await env.say("Pagamos $500.000 de la cuenta corriente de Hierros Córdoba.");
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as PaymentInterpretation;
    expect(p.allocation).toEqual({ type: "unallocated" });
    const revised = await env.post(`/assistant/interpretations/${block.id}/revise`, { interpretation: { ...p, amount: 0 } });
    expect(revised.json.interpretation.validation).toMatchObject({ state: "blocked" });
    expect((await env.confirm(block.id, { ...p, amount: 0 })).status).toBe(422);
    const pending = await env.get("/assistant/pending-actions");
    expect(pending.find((a: { id: string }) => a.id === block.id)).toMatchObject({ status: "pending", validationState: "blocked", unresolvedFields: ["amount"] });
    expect((await env.confirm(block.id, p)).status).toBe(200);
    const confirmed = await env.get("/assistant/pending-actions?status=confirmed");
    expect(confirmed.find((a: { id: string }) => a.id === block.id)).toMatchObject({ status: "confirmed", confirmedAt: expect.any(String) });
    const audit = (await env.db.select().from(t.auditLog)).filter((a) => a.aiInterpretationId === block.id);
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.parse(audit[0]!.metadata!)).toMatchObject({ origin: "ai", pendingActionId: block.id });
  });
});

describe("Scenario F · document fixture with extracted text", () => {
  it("classifies extracted content, proposes, and writes only after review", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
    const env = await setup({
      extractor: (bytes) =>
        new FixtureDocumentContentExtractor(
          { "remito_foto.jpg": "# REMITO N° 0001-00004521\nHierros Córdoba\nPedido N° 38\nFecha: 01/10/2026\n\n20 barras Acero Ø12\n10 barras Acero Ø10" },
          new LocalDocumentContentExtractor(bytes),
        ),
    });
    const docId = await env.upload("remito_foto.jpg", jpeg, "image/jpeg");
    const r = await env.say("", [docId]);
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as DeliveryInterpretation;
    expect(p).toMatchObject({ orderNumber: "38", remito: "0001-00004521", date: "2026-10-01" });
    expect(p.items.map((i) => [i.material, i.now])).toEqual([
      ["Acero Ø12", 20],
      ["Acero Ø10", 10],
    ]);
    expect((await env.orderByNumber("38")).deliveries).toHaveLength(0);
    expect((await env.confirm(block.id, p)).status).toBe(200);
    const order = await env.orderByNumber("38");
    expect(order.delivery.status).toBe("parcial");
    expect(order.documents.some((d: { id: string }) => d.id === docId)).toBe(true);
  });

  it("does not guess when a document cannot be classified with confidence", async () => {
    const env = await setup({ extractor: () => new FixtureDocumentContentExtractor({ "nota.pdf": "Hola, saludos" }) });
    const docId = await env.upload("nota.pdf", new TextEncoder().encode("%PDF-1.4\n%%EOF"), "application/pdf");
    const r = await env.say("", [docId]);
    expect(textOf(r.reply)).toContain("No reconocí nota.pdf");
    expect(blocksOf(r.reply).some((b) => b.type === "interpretation")).toBe(false);
  });
});
