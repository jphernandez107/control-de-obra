import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as t from "../server/db/schema";
import { newId } from "../server/services/context";
import { parseMoneyToMinor, lineTotalMinor } from "../server/domain/money";
import { toMilli } from "../server/domain/quantity";
import type { ConfirmResponse, PaymentInterpretation } from "../src/domain/assistant";
import { pesos, setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
afterEach(() => env?.client.close());

describe("money and quantities", () => {
  it("parses Argentine amounts into integer minor units", () => {
    expect(parseMoneyToMinor("$1.482.340")).toBe(148234000);
    expect(parseMoneyToMinor("1.712,50")).toBe(171250);
    expect(parseMoneyToMinor("400 mil")).toBe(40000000);
    expect(parseMoneyToMinor("1,5 millones")).toBe(150000000);
    expect(parseMoneyToMinor(1712.5)).toBe(171250);
    expect(parseMoneyToMinor(0.1 + 0.2)).toBe(30);
    expect(lineTotalMinor(171250, toMilli(24)!)).toBe(4110000);
    expect(toMilli("6,5")).toBe(6500);
    expect(toMilli("3.000")).toBe(3000000);
  });
});

describe("database constraints", () => {
  it("enforces foreign keys and check constraints inside batches", async () => {
    env = await setup({ empty: true });
    const [project] = await env.db.select().from(t.projects);
    const now = new Date().toISOString();
    await expect(
      env.db.insert(t.orders).values({ id: newId(), projectId: project!.id, supplierId: "no-existe", internalNumber: 1, orderDate: "2026-10-01", source: "manual", createdAt: now, updatedAt: now }),
    ).rejects.toThrow();
    const [supplier] = await env.db.select().from(t.suppliers);
    await expect(
      env.db.insert(t.payments).values({ id: newId(), projectId: project!.id, supplierId: supplier!.id, paymentDate: "2026-10-01", amountMinor: -5, source: "manual", createdAt: now, updatedAt: now }),
    ).rejects.toThrow();
  });
});

describe("business rules", () => {
  it("rejects negative or zero payments and allocations above the payment", async () => {
    env = await setup();
    const supplier = await env.supplierByName("Hierros Córdoba");
    const order = await env.orderByNumber("38");
    const neg = await env.post("/payments", { supplierId: supplier.id, date: "2026-10-02", amount: -100, allocations: [] });
    expect(neg.status).toBe(422);
    expect(neg.json.error.code).toBe("validation");
    const over = await env.post("/payments", { supplierId: supplier.id, date: "2026-10-02", amount: pesos(1000), allocations: [{ orderId: order.id, amount: pesos(2000) }] });
    expect(over.json.error.code).toBe("allocation_exceeds_payment");
    const aboveOrder = await env.post("/payments", { supplierId: supplier.id, date: "2026-10-02", amount: pesos(2000000), allocations: [{ orderId: order.id, amount: pesos(2000000) }] });
    expect(aboveOrder.json.error.code).toBe("allocation_exceeds_order");
    const otherSupplier = await env.orderByNumber("41");
    const wrong = await env.post("/payments", { supplierId: supplier.id, date: "2026-10-02", amount: pesos(1000), allocations: [{ orderId: otherSupplier.id, amount: pesos(1000) }] });
    expect(wrong.json.error.message).toContain("otro proveedor");
  });

  it("allocates an unallocated payment later without changing the supplier balance", async () => {
    env = await setup();
    const before = await env.supplierByName("Hierros Córdoba");
    const payment = before.unallocatedPayments[0];
    const order = await env.orderByNumber("38");
    const res = await env.post(`/payments/${payment.id}/allocations`, { allocations: [{ orderId: order.id, amount: pesos(300000) }] });
    expect(res.status).toBe(201);
    const after = await env.supplierByName("Hierros Córdoba");
    expect(after.balance).toBe(before.balance);
    expect(after.unallocatedPaid).toBe(before.unallocatedPaid - pesos(300000));
    expect((await env.orderByNumber("38")).payment).toMatchObject({ status: "parcial", paid: pesos(300000) });
    const tooMuch = await env.post(`/payments/${payment.id}/allocations`, { allocations: [{ orderId: order.id, amount: pesos(300000) }] });
    expect(tooMuch.json.error.code).toBe("allocation_exceeds_payment");
  });

  it("assistant allocation of an unallocated payment can be undone", async () => {
    env = await setup();
    const r = await env.say("Imputar el pago sin imputar de Hierros Córdoba al pedido 38");
    const block = env.proposalOf(r.reply);
    const p = block.interpretation as PaymentInterpretation;
    expect(p.existingPaymentId).toBeTruthy();
    expect(p.preview.supplierBalanceAfter).toBe(p.preview.supplierBalanceBefore);
    const confirmed = await env.confirm(block.id, p);
    expect((await env.orderByNumber("38")).payment.paid).toBe(pesos(500000));
    await env.post("/assistant/undo", { recordId: confirmed.json.result.recordId });
    expect((await env.orderByNumber("38")).payment.paid).toBe(0);
  });

  it("undo voids records without deleting history and blocks unsafe voids", async () => {
    env = await setup();
    const r = await env.say("Pagamos $250.000 de la cuenta corriente de Sanitarios del Centro");
    const block = env.proposalOf(r.reply);
    const { json } = await env.confirm(block.id, block.interpretation);
    const balance = (await env.supplierByName("Sanitarios del Centro")).balance;
    const undo = await env.post<{ messages: unknown[] }>("/assistant/undo", { recordId: (json as ConfirmResponse).result.recordId, conversationId: r.conversationId });
    expect(undo.status).toBe(200);
    expect((await env.supplierByName("Sanitarios del Centro")).balance).toBe(balance + pesos(250000));
    const paymentId = (json as ConfirmResponse).result.recordId.split(":")[1]!;
    const [row] = await env.db.select().from(t.payments).where(eq(t.payments.id, paymentId));
    expect(row!.voidedAt).toBeTruthy();
    const actions = (await env.db.select().from(t.auditLog).where(eq(t.auditLog.entityId, paymentId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["payment.created", "payment.voided"]));
    // An order with deliveries cannot be voided.
    const delivered = await env.orderByNumber("381");
    const res = await env.post(`/orders/${delivered.id}/void`, {});
    expect(res.status).toBe(409);
    // A reloaded conversation shows the proposal as resolved.
    const thread = await env.get(`/assistant/thread?conversationId=${r.conversationId}`);
    const interp = thread.messages.flatMap((m: any) => m.blocks ?? []).find((b: any) => b.type === "interpretation" && b.id === block.id);
    expect(interp.state).toBe("cancelled");
  });

  it("corrects order prices later and audits before/after", async () => {
    env = await setup();
    const order = await env.orderByNumber("0035");
    expect(order.total).toBeNull();
    const res = await env.call("PATCH", `/orders/${order.id}`, { items: [{ id: order.lines[0].id, unitPrice: pesos(12400) }], reason: "Precio confirmado por el corralón" });
    expect(res.status).toBe(200);
    const fixed = await env.orderByNumber("0035");
    expect(fixed.total).toBe(pesos(20 * 12400));
    const corrected = fixed.history.find((e: any) => e.title === "Registro corregido");
    expect(corrected.changes[0]).toMatchObject({ before: "—", after: "$12.400" });
    expect(corrected.reason).toBe("Precio confirmado por el corralón");
    const pay = await env.say("Pagamos completo el pedido 0035.");
    expect((env.proposalOf(pay.reply).interpretation as PaymentInterpretation).amount).toBe(pesos(248000));
    // Quantities can't go below what was already delivered.
    const delivered = await env.orderByNumber("41");
    const bad = await env.call<any>("PATCH", `/orders/${delivered.id}`, { items: [{ id: delivered.lines[0].id, quantity: 100 }] });
    expect(bad.json.error.code).toBe("invalid_quantity");
  });

  it("answers read-only questions from the database", async () => {
    env = await setup();
    const balance = await env.say("¿Cuánto debemos actualmente a Hierros Córdoba?");
    const block = balance.reply.blocks?.find((b) => b.type === "balance") as any;
    expect(block.balance).toBe(pesos(2982340));
    expect(block.unallocatedPaid).toBe(pesos(500000));
    const pending = await env.say("¿Qué pedidos siguen pendientes de entrega?");
    const rows = (pending.reply.blocks?.find((b) => b.type === "pending_deliveries") as any).rows.map((r: any) => r.orderNumber);
    expect(rows.sort()).toEqual(["0035", "38", "381", "A-1043"]);
    const qty = await env.say("¿Cuánto acero Ø12 llevamos pedido?");
    expect((qty.reply.blocks?.[0] as any).text).toMatch(/^Se pidieron 100 barras de Acero Ø12 de 12 m cada una\. Equivalen a 1\.200 m lineales\./);
    const comp = await env.say("¿Nos estamos pasando del cómputo?");
    expect((comp.reply.blocks?.[0] as any).text).toContain("Acero Ø12 supera el cómputo (111%");
    // Nothing was written by questions.
    const pendingProposals = await env.db.select().from(t.aiInterpretations);
    expect(pendingProposals).toHaveLength(0);
  });

  it("imports a computation spreadsheet through preview and confirm", async () => {
    env = await setup({ empty: true });
    const csv = "Material;Unidad;Cantidad;Etapa\nAcero Ø12;barras;90;Estructura\nHierro del 10;barras;45;Estructura\nMembrana asfáltica;m2;120;Cubierta\n";
    const docId = await env.upload("computo.csv", new TextEncoder().encode(csv), "text/csv");
    const preview = await env.post("/computation/preview", { documentId: docId });
    expect(preview.status).toBe(200);
    expect(preview.json.rows.map((r: any) => [r.name, r.match, r.materialName, r.expected, r.unitCode])).toEqual([
      ["Acero Ø12", "matched", "Acero Ø12", 90, "barra"],
      ["Hierro del 10", "matched", "Acero Ø10", 45, "barra"],
      ["Membrana asfáltica", "new", null, 120, "m2"],
    ]);
    const res = await env.post("/computation/import", {
      documentId: docId,
      rows: preview.json.rows.map((r: any) => ({ materialId: r.materialId, name: r.name, unitCode: r.unitCode, expected: r.expected, stage: r.stage })),
    });
    expect(res.status).toBe(200);
    const materials = await env.get("/materials");
    expect(materials.computation).toMatchObject({ loaded: true, linkedMaterials: 3 });
    expect(materials.materials.some((m: any) => m.name === "Membrana asfáltica")).toBe(true);
  });
});
