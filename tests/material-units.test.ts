import { describe, expect, it } from "vitest";
import { FixtureDocumentContentExtractor } from "../server/ai/document-content";
import { MockAIProvider } from "../server/ai/mock";
import type { AIProvider } from "../server/ai/provider";
import { inferMetric, inferRequestedUnit } from "../server/ai/question-semantics";
import type { AIInterpretationResult } from "../server/ai/schemas";
import * as t from "../server/db/schema";
import { canonicalMaterialName, matchMaterial, steelSpec } from "../server/domain/matching";
import { parsePurchaseFormat, resolveOrderLineUnit } from "../server/domain/units";
import { UNITS } from "../server/dev/catalog";
import type { AssistantBlock, ChatMessage, OrderInterpretation } from "../src/domain/assistant";
import { randomUUID } from "node:crypto";
import { createOrder, registerDelivery } from "../server/services/commands";
import { FIX_QUERIES, planUnitFix, type FixData } from "../server/services/unit-fix";
import { NOW, pesos, setup } from "./helpers";

// Regression scenario from production: supplier order #1 with steel bars sold
// "X BARRA 12 MT" (the quantity counts bars, each 12 m long) and binding wire
// by the kilo. It was imported as meters and summed into "0 de 1.401 u".

const ORDER_1 = [
  "NOTA DE PEDIDO",
  "Hierros Córdoba",
  "Fecha: 25/09/2026",
  "753 HIERRO DIAM.6 X BARRA 12 MT $4.875,00 $3.670.875,00",
  "113 HIERRO DIAM.8 X BARRA 12 MT $8.440,00 $953.720,00",
  "263 HIERRO DIAM.10 X BARRA 12 MT $13.183,00 $3.467.129,00",
  "172 HIERRO DIAM.12 X BARRA 12 MT $18.844,00 $3.241.168,00",
  "100 KG ALAMBRE NEGRO RECOCIDO N°16 $3.260,00 $326.000,00",
  "TOTAL $11.658.892,00",
].join("\n");

/** What a language model returned in production: the bar length read as the unit ("172 m"). */
const MISREAD: AIInterpretationResult = {
  interpretation: {
    intent: "create_order",
    confidence: 0.9,
    note: null,
    supplier: "Hierros Córdoba",
    orderReference: null,
    date: "2026-09-25",
    requestedBy: null,
    purchaseMode: null,
    orderTotal: 11658892,
    items: [
      { material: "HIERRO DIAM.6 X BARRA 12 MT", quantity: 753, unit: "m", unitPrice: 4875 },
      { material: "HIERRO DIAM.8 X BARRA 12 MT", quantity: 113, unit: "m", unitPrice: 8440 },
      { material: "HIERRO DIAM.10 X BARRA 12 MT", quantity: 263, unit: "MT", unitPrice: 13183 },
      { material: "HIERRO DIAM.12 X BARRA 12 MT", quantity: 172, unit: "metros", unitPrice: 18844 },
      { material: "ALAMBRE NEGRO RECOCIDO N°16", quantity: 100, unit: "kg", unitPrice: 3260 },
    ],
  },
  document: { type: "order", confidence: 0.9 },
};

function textOf(reply: { blocks?: AssistantBlock[] }) {
  return (reply.blocks ?? [])
    .filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

/** Production-like project (no catalog) with order #1 imported from its document and confirmed. */
async function withOrder1(options: { misread?: boolean } = {}) {
  const calls = { analyzeDocument: 0, extract: 0 };
  const mock = new MockAIProvider();
  const ai: AIProvider = {
    id: "mock",
    name: "mock",
    model: "reglas-locales",
    configured: true,
    interpret: (input) => mock.interpret(input),
    analyzeDocument: async (input) => {
      calls.analyzeDocument++;
      return options.misread ? MISREAD : mock.analyzeDocument(input);
    },
    answer: (input) => mock.answer(input),
  };
  const fixtures = new FixtureDocumentContentExtractor({ "comprobante_hierros.pdf": ORDER_1 });
  const env = await setup({
    bare: true,
    ai,
    extractor: () => ({ id: "fixture", extract: (doc) => (calls.extract++, fixtures.extract(doc)) }),
  });
  const docId = await env.upload("comprobante_hierros.pdf", new TextEncoder().encode("%PDF-1.4 pedido"), "application/pdf");
  const reply = await env.say("Pedido de Hierros Córdoba", [docId]);
  const proposal = env.proposalOf(reply.reply);
  const interpretation = proposal.interpretation as OrderInterpretation;
  const confirmed = await env.confirm(proposal.id, interpretation);
  expect(confirmed.status).toBe(200);
  const overview = await env.get("/orders");
  const order = await env.get(`/orders/${overview.orders[0].id}`);
  return { ...env, calls, reply: reply.reply, interpretation, order };
}

async function ask(env: Awaited<ReturnType<typeof withOrder1>>, text: string, conversationId?: string) {
  const r = await env.say(text, undefined, conversationId);
  return { text: textOf(r.reply), reply: r.reply as ChatMessage, conversationId: r.conversationId };
}

describe("purchase units: steel bars are counted in bars, with their length as a conversion", () => {
  it("reads the purchase format printed in a description without taking a diameter for a length", () => {
    expect(parsePurchaseFormat("HIERRO DIAM.12 X BARRA 12 MT")).toEqual({ pieceUnit: "barra", size: { milli: 12000, unit: "m" } });
    expect(parsePurchaseFormat("Hierro Ø8 barras de 12 metros")).toEqual({ pieceUnit: "barra", size: { milli: 12000, unit: "m" } });
    expect(parsePurchaseFormat("Cemento portland bolsa x 50 kg")).toEqual({ pieceUnit: "bolsa", size: { milli: 50000, unit: "kg" } });
    expect(parsePurchaseFormat("Cal hidráulica 25 kg", "bolsa")).toEqual({ pieceUnit: "bolsa", size: { milli: 25000, unit: "kg" } });
    expect(parsePurchaseFormat("barra de 12")).toBeNull(); // a Ø12 bar, not a 12 m bar
    expect(parsePurchaseFormat("ALAMBRE NEGRO RECOCIDO N°16")).toBeNull();
  });

  it("turns '172 m' of a 'X BARRA 12 MT' line into 172 bars of 12 m; other explicit units are kept", () => {
    const line = (unit: string | null) => resolveOrderLineUnit("HIERRO DIAM.12 X BARRA 12 MT", unit, UNITS, null);
    expect(line("m")).toEqual({ unit: "barra", size: { milli: 12000, unit: "m" }, corrected: true });
    expect(line("MT")).toEqual({ unit: "barra", size: { milli: 12000, unit: "m" }, corrected: true });
    expect(line(null)).toEqual({ unit: "barra", size: { milli: 12000, unit: "m" }, corrected: false });
    expect(line("barras")).toEqual({ unit: "barra", size: { milli: 12000, unit: "m" }, corrected: false });
    expect(line("kg")).toEqual({ unit: "kg", size: null, corrected: false }); // sold by weight
    expect(resolveOrderLineUnit("ALAMBRE NEGRO RECOCIDO", "kg", UNITS, null)).toEqual({ unit: "kg", size: null, corrected: false });
  });

  it("names new steel canonically so wording variants never create duplicates", () => {
    for (const d of ["HIERRO DIAM.12 X BARRA 12 MT", "hierro del 12", "Barra Ø12", "acero 12 mm", "varilla del 12"]) expect(canonicalMaterialName(d).name).toBe("Acero Ø12");
    expect(canonicalMaterialName("ALAMBRE NEGRO RECOCIDO N°16").name).toBe("Alambre negro recocido n°16");
    expect(canonicalMaterialName("Malla sima Ø4,2").name).toBe("Malla sima Ø4,2");
  });
});

describe("material aliases: construction Spanish resolves to the canonical material", () => {
  const catalog = [
    { id: "a6", name: "Acero Ø6", shortName: "Ø6", aliases: [], baseUnit: "barra" },
    { id: "a10", name: "Acero Ø10", shortName: "Ø10", aliases: [], baseUnit: "barra" },
    { id: "a12", name: "Acero Ø12", shortName: "Ø12", aliases: [], baseUnit: "barra" },
    // As production stored it before the fix: the printed description as the name.
    { id: "p8", name: "Hierro Diam.8 X Barra 12 Mt", shortName: "Hierro Diam.8 X Barra 12 Mt", aliases: [], baseUnit: "m" },
    { id: "wire", name: "Alambre negro recocido n°16", shortName: "alambre", aliases: [], baseUnit: "kg" },
  ];

  it.each(["hierro del 12", "hierro 12", "barra del 12", "barras de 12", "barra de 12", "acero del 12", "acero 12 mm", "ø12", "Ø 12", "12mm", "varilla del 12", "HIERRO DIAM.12 X BARRA 12 MT"])("«%s» → Acero Ø12", (mention) => {
    expect(matchMaterial(mention, catalog)).toMatchObject({ status: "matched", best: { id: "a12" } });
  });

  it("uses the diameter, never the 12 m bar length", () => {
    expect(steelSpec("HIERRO DIAM.10 X BARRA 12 MT").diameter).toBe("10");
    expect(steelSpec("barra de 12 m").diameter).toBeNull();
    expect(matchMaterial("HIERRO DIAM.10 X BARRA 12 MT", catalog)).toMatchObject({ status: "matched", best: { id: "a10" } });
    expect(matchMaterial("hierro del 8", catalog)).toMatchObject({ status: "matched", best: { id: "p8" } });
    expect(matchMaterial("alambre", catalog)).toMatchObject({ status: "matched", best: { id: "wire" } });
  });

  it("leaves vague mentions ambiguous instead of guessing", () => {
    expect(matchMaterial("hierro", catalog).status).not.toBe("matched");
    expect(matchMaterial("barras", catalog).status).not.toBe("matched");
    expect(matchMaterial("hierro del 16", catalog).status).toBe("new");
  });
});

describe("question semantics are decided by the application", () => {
  it.each([
    ["¿Cuántas barras del 12 se pidieron?", "ordered_quantity", "barra"],
    ["¿Cuánto hierro del 12 pedimos?", "ordered_quantity", null],
    ["¿Cuántos metros lineales de hierro Ø12 se pidieron?", "ordered_quantity", "m"],
    ["¿Cuántos kilos de alambre se pidieron?", "ordered_quantity", "kg"],
    ["¿Cuántas barras del 12 llegaron?", "delivered_quantity", "barra"],
    ["¿Cuánto hierro del 12 recibimos?", "delivered_quantity", null],
    ["¿Cuántas barras del 12 faltan?", "pending_delivery_quantity", "barra"],
    ["¿Cuánto falta que llegue?", "pending_delivery_quantity", null],
    ["¿Cuántas barras del 12 necesitamos?", "expected_quantity", "barra"],
    ["¿Cuánto hierro del 12 está computado?", "expected_quantity", null],
    ["¿Cuánto falta comprar?", "remaining_to_order_quantity", null],
    ["¿Cuánto falta pedir?", "remaining_to_order_quantity", null],
    ["¿Cuánto salió el hierro del 12?", "ordered_amount", null],
    ["¿Cuánto costó cada barra del 12?", "unit_price", null],
  ])("%s → %s", (question, metric, unit) => {
    expect(inferMetric(question)).toBe(metric);
    expect(inferRequestedUnit(question)).toBe(unit);
  });

  it("does not mistake money or order questions for material quantities", () => {
    expect(inferMetric("¿Cuánto falta pagar del pedido 38?")).toBeNull();
    expect(inferMetric("¿Cuánto debemos a Hierros Córdoba?")).toBeNull();
    expect(inferMetric("¿Cómo viene el pedido 38?")).toBeNull();
  });
});

describe("production order #1 (regression)", () => {
  it("imports bars as bars with a 12 m conversion, from the document as the mock reads it", async () => {
    const env = await withOrder1();
    expect(env.interpretation.items.map((i) => [i.material, i.quantity, i.unit, i.unitSize, i.unitPrice])).toEqual([
      ["Acero Ø6", 753, "barras", { quantity: 12, unit: "m" }, pesos(4875)],
      ["Acero Ø8", 113, "barras", { quantity: 12, unit: "m" }, pesos(8440)],
      ["Acero Ø10", 263, "barras", { quantity: 12, unit: "m" }, pesos(13183)],
      ["Acero Ø12", 172, "barras", { quantity: 12, unit: "m" }, pesos(18844)],
      ["Alambre negro recocido n°16", 100, "kg", undefined, pesos(3260)],
    ]);
    const rows = await env.db.select().from(t.orderItems);
    const a12 = rows.find((r) => r.quantityMilli === 172_000)!;
    expect(a12).toMatchObject({ unit: "barra", unitSizeMilli: 12_000, unitSizeUnit: "m", unitPriceMinor: pesos(18844), lineTotalMinor: pesos(3241168) });
    expect(env.order.total).toBe(pesos(11658892));
  });

  it("corrects a provider that read the bar length as the unit ('172 m') and says so on the review card", async () => {
    const env = await withOrder1({ misread: true });
    expect(env.interpretation.items.map((i) => `${i.quantity} ${i.unit}`)).toEqual(["753 barras", "113 barras", "263 barras", "172 barras", "100 kg"]);
    expect(env.interpretation.items[3]).toMatchObject({ material: "Acero Ø12", mention: "HIERRO DIAM.12 X BARRA 12 MT", unitSize: { quantity: 12, unit: "m" } });
    expect(textOf(env.reply)).toBe("Es un comprobante de pedido de Hierros Córdoba. Revisa antes de guardar:");
    const note = env.reply.blocks?.find((b) => b.type === "note") as { text: string };
    expect(note.text).toContain("Tomé la cantidad como piezas compradas, no como medida: 753 barras de 12 m (Acero Ø6)");
    // The printed wording is remembered, and the catalog learns 1 barra = 12 m.
    const aliases = await env.db.select().from(t.materialAliases);
    expect(aliases.map((a) => a.alias)).toContain("HIERRO DIAM.12 X BARRA 12 MT");
    const conversions = await env.db.select().from(t.unitConversions);
    expect(conversions.filter((c) => c.fromUnit === "barra" && c.toUnit === "m" && c.factorNum === 12 && c.factorDen === 1)).toHaveLength(4);
  });

  it("never adds bars and kilograms together in order or material summaries", async () => {
    const env = await withOrder1();
    expect(env.order.delivery).toMatchObject({ status: "pendiente", lines: 5, completeLines: 0, deliveries: 0, percent: 0, sameUnit: null });
    expect(JSON.stringify(env.order)).not.toMatch(/1401|1\.401/);
    expect(env.order.lines[3]).toMatchObject({ quantity: 172, unit: "barras", unitSize: { quantity: 12, unit: "m" }, equivalent: { quantity: 2064, unit: "m" } });
    expect(env.order.itemsLabel).toBe("5 materiales");
    const materials = await env.get("/materials");
    const a12 = materials.materials.find((m: { name: string }) => m.name === "Acero Ø12");
    expect(a12).toMatchObject({ unit: "barras", ordered: 172, delivered: 0, pendingDelivery: 172, equivalent: { quantity: 2064, unit: "m" } });
    expect(materials.materials).toHaveLength(5);
  });

  it("answers the regression questions from persisted records, leading with the requested fact", async () => {
    const env = await withOrder1();
    const before = { ...env.calls };
    expect((await ask(env, "¿Cuántas barras del 12 se pidieron?")).text).toMatch(/^Se pidieron 172 barras de Acero Ø12 de 12 m cada una\. Equivalen a 2\.064 m lineales\./);
    expect((await ask(env, "cuantas barras del 12 se pidieron?")).text).toMatch(/^Se pidieron 172 barras de Acero Ø12/);
    expect((await ask(env, "¿Cuántas barras del 10 se pidieron?")).text).toMatch(/^Se pidieron 263 barras de Acero Ø10/);
    expect((await ask(env, "¿Cuántos kilos de alambre se pidieron?")).text).toMatch(/^Se pidieron 100 kg de Alambre negro recocido n°16\./);
    expect((await ask(env, "¿Cuántos metros lineales de hierro Ø12 se pidieron?")).text).toMatch(/^Se pidieron 2\.064 m lineales de Acero Ø12 \(172 barras de 12 m cada una\)\./);
    expect((await ask(env, "¿Cuánto salió el hierro del 12?")).text).toMatch(/^Acero Ø12 salió \$3\.241\.168: 172 barras a \$18\.844 cada una/);
    expect((await ask(env, "¿Cuánto costó cada barra del 12?")).text).toMatch(/^Cada barra de Acero Ø12 costó \$18\.844/);
    // Questions never re-read the original document.
    expect(env.calls).toEqual(before);
    expect(await env.db.select().from(t.aiInterpretations).then((r) => r.length)).toBe(1); // only the import proposal
  });

  it("keeps the material across follow-up questions", async () => {
    const env = await withOrder1();
    const first = await ask(env, "¿Cuántas barras del 12 se pidieron?");
    const follow = await ask(env, "¿y cuántas llegaron?", first.conversationId);
    expect(follow.text).toMatch(/^Todavía no llegó ninguna barra de Acero Ø12\. Hay 172 barras pendientes de entrega\./);
    const again = await ask(env, "¿Cuántas barras llegaron?", first.conversationId);
    expect(again.text).toMatch(/^Todavía no llegó ninguna barra de Acero Ø12/);
    const price = await ask(env, "¿Y cuánto costó cada una?", first.conversationId);
    expect(price.text).toMatch(/^Cada barra de Acero Ø12 costó \$18\.844/);
  });

  it("asks which material when the question is vague and there is no context", async () => {
    const env = await withOrder1();
    const r = await ask(env, "¿Cuántas barras se pidieron?");
    expect(r.text).toBe("¿De qué diámetro? Hay Acero Ø6, Acero Ø8, Acero Ø10 y Acero Ø12.");
    const chips = r.reply.blocks?.find((b) => b.type === "actions") as Extract<AssistantBlock, { type: "actions" }>;
    expect(chips.actions.map((a) => a.prompt)).toContain("¿Cuánto se pidió de Acero Ø12?");
    expect((await ask(env, chips.actions[3]!.prompt!)).text).toMatch(/^Se pidieron 172 barras de Acero Ø12/);
  });

  it("separates ordered, delivered, pending delivery, computation and remaining to order", async () => {
    const env = await withOrder1();
    expect((await ask(env, "¿Cuántas barras del 12 necesitamos?")).text).toMatch(/^Acero Ø12 no tiene cómputo cargado/);
    expect((await ask(env, "¿Cuánto hierro del 12 falta pedir?")).text).toMatch(/^No puedo calcular cuánto falta pedir de Acero Ø12: no tiene cómputo cargado\. Hasta ahora se pidieron 172 barras\./);
    const a12 = (await env.get("/materials")).materials.find((m: { name: string }) => m.name === "Acero Ø12");
    expect((await env.call("PUT", `/materials/${a12.id}/computation`, { expected: 200 })).status).toBe(200);
    expect((await ask(env, "¿Cuántas barras del 12 necesitamos?")).text).toMatch(/^El cómputo prevé 200 barras de Acero Ø12\. Se pidieron 172 barras \(86%\)\./);
    expect((await ask(env, "¿Cuánto hierro del 12 falta pedir?")).text).toMatch(/^Falta pedir 28 barras de Acero Ø12: el cómputo prevé 200 barras y se pidieron 172 barras\./);

    const delivery = await env.say("Del pedido 1 llegaron 100 barras del 12");
    const proposal = env.proposalOf(delivery.reply);
    expect((await env.confirm(proposal.id, proposal.interpretation)).status).toBe(200);
    expect((await ask(env, "¿Cuántas barras del 12 llegaron?")).text).toMatch(/^Llegaron 100 de las 172 barras de Acero Ø12\. Faltan 72 barras\. La última entrega fue el 02\/10\/2026\./);
    expect((await ask(env, "¿Cuántas barras del 12 faltan?")).text).toMatch(/^Faltan entregar 72 barras de Acero Ø12 \(llegaron 100 barras de 172 barras\)/);
    // Remaining to order is about the computation, not deliveries.
    expect((await ask(env, "¿Cuánto hierro del 12 falta pedir?")).text).toMatch(/^Falta pedir 28 barras/);
    const order = await env.get(`/orders/${env.order.id}`);
    expect(order.delivery).toMatchObject({ status: "parcial", lines: 5, completeLines: 0, sameUnit: null });
  });

  it("re-routes a provider's generic order summary to the material fact asked", async () => {
    const base = new MockAIProvider();
    // A model that classified the production question as an order summary with no material.
    const slipping: AIProvider = {
      ...base,
      id: "mock",
      name: "mock",
      configured: true,
      interpret: async (input) =>
        /barras del 12/.test(input.text)
          ? { interpretation: { intent: "ask_project_question", confidence: 0.8, note: null, query: "get_order_summary", supplier: null, orderReference: "1", material: null, aspect: "overall", refersToPrevious: false }, document: null }
          : base.interpret(input),
      analyzeDocument: (input) => base.analyzeDocument(input),
      answer: (input) => base.answer(input),
    };
    const env = await setup({ bare: true, ai: slipping, extractor: () => new FixtureDocumentContentExtractor({ "comprobante_hierros.pdf": ORDER_1 }) });
    const docId = await env.upload("comprobante_hierros.pdf", new TextEncoder().encode("%PDF-1.4"), "application/pdf");
    const reply = await env.say("Pedido de Hierros Córdoba", [docId]);
    const p = env.proposalOf(reply.reply);
    await env.confirm(p.id, p.interpretation);
    const answer = await env.say("cuantas barras del 12 se pidieron?");
    expect(textOf(answer.reply)).toMatch(/^Se pidieron 172 barras de Acero Ø12 de 12 m cada una en el pedido #1\./);
    expect(textOf(answer.reply)).not.toContain("pendiente de entrega y");
  });
});

describe("targeted correction of order #1 as production stored it (172 m)", () => {
  /** Order #1 as the first import persisted it: bars stored as meters under the printed description. */
  async function asProductionStoredIt() {
    const env = await setup({ bare: true });
    const [juan] = await env.db.select().from(t.users);
    const ctx = { db: env.db, projectId: env.projectId, actor: { userId: juan!.id, name: juan!.name, role: juan!.role }, source: "assistant" as const, now: () => NOW };
    const bars = [
      ["HIERRO DIAM.6 X BARRA 12 MT", 753, 4875],
      ["HIERRO DIAM.8 X BARRA 12 MT", 113, 8440],
      ["HIERRO DIAM.10 X BARRA 12 MT", 263, 13183],
      ["HIERRO DIAM.12 X BARRA 12 MT", 172, 18844],
    ] as const;
    await createOrder(ctx, {
      supplier: { newName: "Hierros Córdoba" },
      date: "2026-09-25",
      purchaseMode: "cuenta_corriente",
      items: [
        ...bars.map(([name, qty, price]) => ({ material: { newName: name, unit: "m" }, description: name, quantityMilli: qty * 1000, unit: "m", unitPriceMinor: pesos(price) })),
        { material: { newName: "ALAMBRE NEGRO RECOCIDO N°16", unit: "kg" }, description: "ALAMBRE NEGRO RECOCIDO N°16", quantityMilli: 100_000, unit: "kg", unitPriceMinor: pesos(3260) },
      ],
    });
    const read = async (): Promise<FixData> => {
      const data = {} as Record<string, unknown[]>;
      for (const [key, sql] of Object.entries(FIX_QUERIES)) data[key] = (await env.client.execute(sql)).rows.map((r) => ({ ...r }));
      return data as unknown as FixData;
    };
    return { ...env, ctx, read };
  }

  it("plans only lines with explicit evidence, applies idempotently and keeps an audit entry", async () => {
    const env = await asProductionStoredIt();
    const before = await env.get(`/orders/${(await env.get("/orders")).orders[0].id}`);
    expect(before.lines[3]).toMatchObject({ quantity: 172, unit: "m" });

    let n = 0;
    const plan = planUnitFix(await env.read(), { order: "1", now: NOW.toISOString(), newId: () => `fix-${++n}` });
    expect(plan.lines.map((l) => `${l.description}: ${l.before} → ${l.after}`)).toEqual([
      "HIERRO DIAM.6 X BARRA 12 MT: 753 m → 753 barras de 12 m",
      "HIERRO DIAM.8 X BARRA 12 MT: 113 m → 113 barras de 12 m",
      "HIERRO DIAM.10 X BARRA 12 MT: 263 m → 263 barras de 12 m",
      "HIERRO DIAM.12 X BARRA 12 MT: 172 m → 172 barras de 12 m",
    ]); // the wire (kg) is not touched
    expect(plan.materials.map((m) => m.after)).toEqual(["Acero Ø6 (barra)", "Acero Ø8 (barra)", "Acero Ø10 (barra)", "Acero Ø12 (barra)"]);
    expect(planUnitFix(await env.read(), { order: "2", now: NOW.toISOString(), newId: () => "x" }).lines).toHaveLength(0);

    await env.client.batch(plan.statements, "write");
    const after = await env.get(`/orders/${before.id}`);
    expect(after.lines[3]).toMatchObject({ quantity: 172, unit: "barras", unitSize: { quantity: 12, unit: "m" }, equivalent: { quantity: 2064, unit: "m" }, amount: pesos(3241168) });
    expect(after.total).toBe(pesos(11658892));
    expect(after.history).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Registro corregido", description: "Pedido #1 · Hierros Córdoba · unidad de compra corregida" })]));
    const answer = await env.say("¿Cuántas barras del 12 se pidieron?");
    expect(textOf(answer.reply)).toMatch(/^Se pidieron 172 barras de Acero Ø12 de 12 m cada una\. Equivalen a 2\.064 m lineales\./);
    // The printed name still matches future documents.
    expect((await env.db.select().from(t.materialAliases)).map((a) => a.alias)).toContain("HIERRO DIAM.12 X BARRA 12 MT");
    // Running it again changes nothing.
    expect(planUnitFix(await env.read(), { now: NOW.toISOString(), newId: () => "y" }).statements).toHaveLength(0);
  });

  it("skips a line with deliveries recorded in meters", async () => {
    const env = await asProductionStoredIt();
    const order = await env.get(`/orders/${(await env.get("/orders")).orders[0].id}`);
    await registerDelivery(env.ctx, { orderId: order.id, date: "2026-09-30", items: [{ orderItemId: order.lines[3].id, quantityMilli: 24_000 }] });
    const plan = planUnitFix(await env.read(), { now: NOW.toISOString(), newId: randomUUID });
    expect(plan.lines).toHaveLength(3);
    expect(plan.skipped).toEqual([expect.objectContaining({ description: "HIERRO DIAM.12 X BARRA 12 MT", reason: "tiene entregas registradas en esa unidad; corrígelo a mano" })]);
  });
});

describe("material questions on the demo project", () => {
  it("keeps order and supplier questions on their own route, and filters material facts by supplier or order", async () => {
    const env = await setup();
    const delivery = await env.say("¿Qué falta que llegue del pedido 381 de Hierros Córdoba?");
    expect(textOf(delivery.reply)).toMatch(/^Del pedido 381 de Hierros Córdoba llegó una parte: faltan/);
    const bySupplier = await env.say("¿Cuántas barras del 12 le pedimos a Hierros Córdoba?");
    expect(textOf(bySupplier.reply)).toMatch(/^Se pidieron 100 barras de Acero Ø12 de 12 m cada una a Hierros Córdoba\./);
    const byOrder = await env.say("¿Cuántas barras del 12 se pidieron en el pedido 381?");
    expect(textOf(byOrder.reply)).toMatch(/^Se pidieron 20 barras de Acero Ø12 de 12 m cada una en el pedido 381\. Equivalen a 240 m lineales\.$/);
    const prices = await env.say("¿Cuánto costó cada barra del 12?");
    expect(textOf(prices.reply)).toMatch(/^Acero Ø12 se pagó a distintos precios: \$18\.000 por barra en el pedido 352/);
    expect(textOf((await env.say("¿Cuánto debemos a Hierros Córdoba?")).reply)).toMatch(/^Hoy el saldo con Hierros Córdoba es de/);
  });
});
