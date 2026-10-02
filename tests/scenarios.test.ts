import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as t from "../server/db/schema";
import { simplePdf } from "../server/dev/pdf";
import type { DeliveryInterpretation, OrderInterpretation, PaymentInterpretation } from "../src/domain/assistant";
import { pesos, setup } from "./helpers";

// Minimum end-to-end scenarios A–H, run through the HTTP API with a real
// SQLite database, the deterministic AI provider and the domain services.

let env: Awaited<ReturnType<typeof setup>>;
afterEach(() => env?.client.close());

const pdf = (lines: string[]) => simplePdf([{ text: lines[0]!, size: 15, bold: true }, ...lines.slice(1).map((text) => ({ text }))]);

describe("Scenario A · create order from text", () => {
  it("interprets, lets the user edit, persists on confirm and audits", async () => {
    env = await setup();
    const before = await env.get("/orders");
    const reply = await env.say("Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba.");
    const block = env.proposalOf(reply.reply);
    const proposal = block.interpretation as OrderInterpretation;
    expect(proposal.kind).toBe("order");
    expect(proposal.supplierName).toBe("Hierros Córdoba");
    expect(proposal.supplierMatch).toBe("matched");
    expect(proposal.orderedBy).toBe("Marcelo Ríos");
    expect(proposal.items.map((i) => [i.material, i.quantity, i.unit, i.match])).toEqual([
      ["Acero Ø12", 20, "barras", "matched"],
      ["Acero Ø10", 30, "barras", "matched"],
    ]);
    // Nothing persisted before confirmation.
    expect((await env.get("/orders")).orders.length).toBe(before.orders.length);

    // The user edits the proposal: supplier reference and a price.
    const edited: OrderInterpretation = { ...proposal, number: "52", items: proposal.items.map((i, idx) => (idx === 0 ? { ...i, unitPrice: pesos(38420) } : i)) };
    const confirmed = await env.confirm(block.id, edited);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.result.title).toBe("Pedido 52 registrado");
    expect(confirmed.json.messages).toHaveLength(2);

    const order = await env.orderByNumber("52");
    expect(order.supplier.name).toBe("Hierros Córdoba");
    expect(order.lines.map((l: any) => [l.materialName, l.quantity, l.unitPrice])).toEqual([
      ["Acero Ø12", 20, pesos(38420)],
      ["Acero Ø10", 30, null],
    ]);
    expect(order.total).toBeNull(); // one line without price → value unknown, not invented
    expect(order.delivery.status).toBe("pendiente");
    expect(order.registeredVia).toBe("asistente");

    const audit = await env.db.select().from(t.auditLog).where(eq(t.auditLog.orderId, order.id));
    const created = audit.find((a) => a.action === "order.created")!;
    expect(created.source).toBe("assistant");
    expect(created.aiInterpretationId).toBe(block.id);
    expect(created.actorUserId).toBeTruthy();
    const [row] = await env.db.select().from(t.aiInterpretations).where(eq(t.aiInterpretations.id, block.id));
    expect(row!.status).toBe("confirmed");
    expect(row!.resultEntityId).toBe(order.id);
    // A confirmed proposal cannot be confirmed twice.
    expect((await env.confirm(block.id, edited)).status).toBe(409);
  });

  it("does not create duplicate materials and flags weak matches", async () => {
    env = await setup();
    const reply = await env.say("Pedimos 40 bolsas de cemento y 10 bolsas de hidrófugo al Corralón San Martín");
    const p = env.proposalOf(reply.reply).interpretation as OrderInterpretation;
    expect(p.items[0]).toMatchObject({ material: "Cemento portland 50 kg", match: "matched" });
    expect(p.items[1]).toMatchObject({ materialId: null, match: "new", unit: "bolsas" });
    const materialsBefore = (await env.get("/materials/options")).length;
    const r = await env.confirm(env.proposalOf(reply.reply).id, p);
    expect(r.status).toBe(200);
    expect((await env.get("/materials/options")).length).toBe(materialsBefore + 1);
  });
});

describe("Scenarios B and C · partial then remaining delivery", () => {
  it("derives partial and complete delivery state from deliveries", async () => {
    env = await setup();
    const b = await env.say("Del pedido 38 llegaron las 20 barras del 12 y 25 barras del 10.");
    const blockB = env.proposalOf(b.reply);
    const delivery = blockB.interpretation as DeliveryInterpretation;
    expect(delivery.orderNumber).toBe("38");
    expect(delivery.items.map((i) => [i.material, i.ordered, i.before, i.now])).toEqual([
      ["Acero Ø12", 20, 0, 20],
      ["Acero Ø10", 30, 0, 25],
    ]);
    expect((await env.orderByNumber("38")).delivery.status).toBe("pendiente");
    expect((await env.confirm(blockB.id, { ...delivery, remito: "0012-4590" })).status).toBe(200);

    let order = await env.orderByNumber("38");
    expect(order.delivery.status).toBe("parcial");
    expect(order.lines.map((l: any) => [l.materialName, l.delivered, l.quantity])).toEqual([
      ["Acero Ø12", 20, 20],
      ["Acero Ø10", 25, 30],
    ]);
    expect(order.delivery.pendingLabel).toBe("Faltan 5 barras Ø10");
    expect(order.payment.status).toBe("sin_pagos"); // deliveries never change payment state

    const c = await env.say("Se entregó todo lo pendiente del pedido 38.");
    const blockC = env.proposalOf(c.reply);
    const rest = blockC.interpretation as DeliveryInterpretation;
    expect(rest.items.map((i) => [i.material, i.now])).toEqual([["Acero Ø10", 5]]);
    expect((await env.confirm(blockC.id, rest)).status).toBe(200);
    order = await env.orderByNumber("38");
    expect(order.delivery.status).toBe("entregado");
    expect(order.deliveries).toHaveLength(2);

    const again = await env.say("Se entregó todo lo pendiente del pedido 38.");
    expect(again.reply.blocks?.some((b) => b.type === "interpretation")).toBe(false);
  });

  it("infers the order from the material when no number is given", async () => {
    env = await setup();
    const r = await env.say("Llegaron las 5 barras del 10.");
    const p = env.proposalOf(r.reply).interpretation as DeliveryInterpretation;
    expect(p.orderNumber).toBe("381"); // only 5 Ø10 remained there — exact match preferred
    expect(p.flags).toContain("orderNumber");
  });

  it("does not silently accept a delivery above the ordered quantity", async () => {
    env = await setup();
    const r = await env.say("Del pedido 38 llegaron 25 barras del 12.");
    const block = env.proposalOf(r.reply);
    expect((block.interpretation as DeliveryInterpretation).items[0]!.now).toBe(20);
    expect(r.reply.blocks?.some((b) => b.type === "note" && b.text.includes("solo faltan"))).toBe(true);
    // A direct over-delivery is rejected by the domain.
    const order = await env.orderByNumber("38");
    const res = await env.post("/deliveries", { orderId: order.id, date: "2026-10-02", items: [{ orderItemId: order.lines[0].id, quantity: 25 }] });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("over_delivery");
  });
});

describe("Scenario D · payment to the supplier's current account", () => {
  it("lowers the supplier balance without allocating to an order", async () => {
    env = await setup();
    const before = await env.supplierByName("Hierros Córdoba");
    const r = await env.say("Pagamos $500.000 de la cuenta corriente de Hierros Córdoba.");
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as PaymentInterpretation;
    expect(p.amount).toBe(pesos(500000));
    expect(p.allocation).toEqual({ type: "unallocated" });
    expect(p.preview.supplierBalanceAfter).toBe(before.balance - pesos(500000));
    expect((await env.supplierByName("Hierros Córdoba")).balance).toBe(before.balance); // not before confirming
    expect((await env.confirm(block.id, p)).status).toBe(200);
    const after = await env.supplierByName("Hierros Córdoba");
    expect(after.balance).toBe(before.balance - pesos(500000));
    expect(after.unallocatedPaid).toBe(before.unallocatedPaid + pesos(500000));
    expect(after.allocatedPaid).toBe(before.allocatedPaid);
    // Order-level balances are untouched by an unallocated payment.
    expect(after.openOrderList.map((o: any) => o.pendingPayment)).toEqual(before.openOrderList.map((o: any) => o.pendingPayment));
  });
});

describe("Scenario E · pay an order in full", () => {
  it("proposes exactly the outstanding allocated balance", async () => {
    env = await setup();
    const r = await env.say("Pagamos completo el pedido 381.");
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as PaymentInterpretation;
    // 381 is worth $1.482.340 and already has $600.000 allocated; unallocated supplier payments do not count.
    expect(p.amount).toBe(pesos(882340));
    expect(p.allocation).toMatchObject({ type: "order", orderNumber: "381" });
    expect((await env.confirm(block.id, p)).status).toBe(200);
    const order = await env.orderByNumber("381");
    expect(order.payment.status).toBe("pagado");
    expect(order.pendingPayment).toBe(0);
    expect(order.payments).toHaveLength(2);
  });

  it("pays order 38 after its deliveries", async () => {
    env = await setup();
    const r = await env.say("Pagamos completo el pedido 38.");
    const block = env.proposalOf(r.reply);
    expect((block.interpretation as PaymentInterpretation).amount).toBe(pesos(1482340));
    await env.confirm(block.id, block.interpretation);
    expect((await env.orderByNumber("38")).payment.status).toBe("pagado");
  });

  it("does not invent an amount when the order value is unknown", async () => {
    env = await setup();
    const r = await env.say("Pagamos completo el pedido 0035.");
    expect(r.reply.blocks?.some((b) => b.type === "interpretation")).toBe(false);
    const text = r.reply.blocks?.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(text).toContain("no tiene importe cargado");
  });

  it("splits one payment across several orders", async () => {
    env = await setup();
    const r = await env.say("Pagamos 1 millón: 600 mil al pedido 381 y 400 mil al pedido 352 de Hierros Córdoba");
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as PaymentInterpretation;
    expect(p.allocation.type).toBe("split");
    expect((await env.confirm(block.id, p)).status).toBe(200);
    expect((await env.orderByNumber("381")).payment.paid).toBe(pesos(1200000));
    expect((await env.orderByNumber("352")).payment.paid).toBe(pesos(1000000));
  });
});

describe("Scenario F · documents", () => {
  it("stores, analyzes and links a remito only after confirmation", async () => {
    env = await setup();
    const docId = await env.upload("remito_hierros_0012-4601.pdf", pdf(["REMITO N° 0012-4601", "Hierros Córdoba", "Fecha: 02/10/2026", "Pedido 38", "20 barras Acero Ø12", "25 barras Acero Ø10"]), "application/pdf");
    const [stored] = await env.db.select().from(t.documents).where(eq(t.documents.id, docId));
    expect(stored!.mimeType).toBe("application/pdf");
    expect(await env.storage.get(stored!.storageKey)).not.toBeNull();

    const r = await env.say("", [docId]);
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as DeliveryInterpretation;
    expect(p.kind).toBe("delivery");
    expect(p.orderNumber).toBe("38");
    expect(p.remito).toBe("0012-4601");
    expect(p.items.map((i) => i.now)).toEqual([20, 25]);
    expect(p.document?.documentId).toBe(docId);
    // Nothing mutated yet: no delivery, no link.
    expect((await env.orderByNumber("38")).deliveries).toHaveLength(0);
    expect(await env.db.select().from(t.documentLinks).where(eq(t.documentLinks.documentId, docId))).toHaveLength(0);

    expect((await env.confirm(block.id, p)).status).toBe(200);
    const order = await env.orderByNumber("38");
    expect(order.deliveries[0].document.id).toBe(docId);
    expect(order.documents.some((d: any) => d.id === docId && d.kind === "remito")).toBe(true);
    const file = await env.app.request(`/api/documents/${docId}/file`);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect((await file.arrayBuffer()).byteLength).toBe(stored!.sizeBytes);
  });

  it("matches a payment receipt to the referenced order", async () => {
    env = await setup();
    const docId = await env.upload("transferencia_hierros.pdf", pdf(["Comprobante de transferencia", "Destinatario: Hierros Córdoba", "Importe: $350.000", "Concepto: pago pedido 381"]), "application/pdf");
    const r = await env.say("", [docId]);
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as PaymentInterpretation;
    expect(p.amount).toBe(pesos(350000));
    expect(p.allocation).toMatchObject({ type: "order", orderNumber: "381" });
    await env.confirm(block.id, p);
    const order = await env.orderByNumber("381");
    expect(order.payment.paid).toBe(pesos(950000));
    expect(order.documents.some((d: any) => d.id === docId)).toBe(true);
  });

  it("suggests an order for a receipt without reference only on an exact balance match, flagged", async () => {
    env = await setup();
    const docId = await env.upload("transferencia_sanitarios.pdf", pdf(["Comprobante de transferencia", "Destinatario: Sanitarios del Centro", "Importe: $612.300", "Concepto: materiales"]), "application/pdf");
    const r = await env.say("", [docId]);
    const p = env.proposalOf(r.reply).interpretation as PaymentInterpretation;
    expect(p.allocation).toMatchObject({ type: "order", orderNumber: "A-1043" });
    expect(p.flags).toContain("allocation");
    expect((await env.orderByNumber("A-1043")).payment.paid).toBe(0);
    const other = await env.upload("transferencia_sanitarios_2.pdf", pdf(["Comprobante de transferencia", "Destinatario: Sanitarios del Centro", "Importe: $100.000"]), "application/pdf");
    const r2 = await env.say("", [other]);
    expect((env.proposalOf(r2.reply).interpretation as PaymentInterpretation).allocation).toEqual({ type: "unallocated" });
  });

  it("turns an order proof into an order proposal with prices", async () => {
    env = await setup();
    const docId = await env.upload("nota_pedido_corralon.pdf", pdf(["NOTA DE PEDIDO N° 0041", "Corralón San Martín", "30 bolsas Cemento portland 50 kg $12.400", "4 m3 Arena gruesa $45.000"]), "application/pdf");
    const r = await env.say("Marcelo pidió esto", [docId]);
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as OrderInterpretation;
    expect(p.number).toBe("0041");
    expect(p.supplierName).toBe("Corralón San Martín");
    expect(p.items.map((i) => [i.material, i.quantity, i.unitPrice])).toEqual([
      ["Cemento portland 50 kg", 30, pesos(12400)],
      ["Arena gruesa", 4, pesos(45000)],
    ]);
    await env.confirm(block.id, p);
    const order = await env.orderByNumber("0041");
    expect(order.total).toBe(pesos(30 * 12400 + 4 * 45000));
    expect(order.hasDocument).toBe(true);
  });

  it("reports unreadable and unsupported documents in Spanish without writing", async () => {
    env = await setup();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
    const docId = await env.upload("foto_borrosa.jpg", jpeg, "image/jpeg");
    const r = await env.say("", [docId]);
    expect(r.reply.blocks?.[0]?.type).toBe("read_error");
    const bad = new FormData();
    bad.append("file", new File([new TextEncoder().encode("hola")], "nota.exe", { type: "application/x-msdownload" }));
    const res = await env.call<any>("POST", "/documents", bad);
    expect(res.status).toBe(415);
    expect(res.json.error.message).toContain("Formato no soportado");
  });
});

describe("Scenarios G and H · no computation, then a later computation", () => {
  it("works without computation and compares history once it is added", async () => {
    env = await setup({ empty: true });
    // G: everything works with no computation loaded.
    const a = await env.say("Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba.");
    const orderBlock = env.proposalOf(a.reply);
    const order = orderBlock.interpretation as OrderInterpretation;
    await env.confirm(orderBlock.id, { ...order, number: "7", items: order.items.map((i) => ({ ...i, unitPrice: pesos(10000) })) });
    const d = await env.say("Del pedido 7 llegaron 20 barras del 12.");
    await env.confirm(env.proposalOf(d.reply).id, env.proposalOf(d.reply).interpretation);
    const p = await env.say("Pagamos $200.000 al pedido 7 de Hierros Córdoba por transferencia hoy");
    const payBlock = env.proposalOf(p.reply);
    await env.confirm(payBlock.id, payBlock.interpretation);

    let materials = await env.get("/materials");
    expect(materials.computation.loaded).toBe(false);
    expect(materials.counts.sin_computo).toBe(2);
    const steel = materials.materials.find((m: any) => m.name === "Acero Ø12");
    expect(steel).toMatchObject({ ordered: 20, delivered: 20, computation: null });
    const supplier = await env.supplierByName("Hierros Córdoba");
    expect(supplier.balance).toBe(pesos(500000 - 200000));
    expect((await env.orderByNumber("7")).delivery.status).toBe("parcial");

    // H: computation added later — historical orders are compared immediately, no reassignment.
    const res = await env.call("PUT", `/materials/${steel.id}/computation`, { expected: 18 });
    expect(res.status).toBe(200);
    materials = await env.get("/materials");
    expect(materials.computation.loaded).toBe(true);
    const compared = materials.materials.find((m: any) => m.id === steel.id);
    expect(compared.computation).toMatchObject({ expected: 18, percent: 111, status: "supera", variation: 2 });

    // Revising keeps the previous baseline in history.
    await env.call("PUT", `/materials/${steel.id}/computation`, { expected: 24, reason: "Faltaban las columnas" });
    const detail = await env.get(`/materials/${steel.id}`);
    expect(detail.computation).toMatchObject({ expected: 24, status: "dentro" });
    expect(detail.computationChanges.map((c: any) => [c.before, c.after])).toEqual([
      [null, 18],
      [18, 24],
    ]);
    const revisions = await env.db.select().from(t.computationRevisions);
    expect(revisions).toHaveLength(2);
    const activity = await env.get("/activity?kind=computo_actualizado");
    expect(activity.events.length).toBe(2);
  });
});
