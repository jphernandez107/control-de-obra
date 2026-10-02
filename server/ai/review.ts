import type { ConfirmResult, DeliveryInterpretation, Interpretation, OrderInterpretation, PaymentInterpretation } from "../../src/domain/assistant";
import type { StatusTag } from "../../src/domain/types";
import { deliveryAmountLabel, formatDate, formatMoney, paymentMethodLabel } from "../../src/domain/format";
import type { Ledger } from "../domain/derive";
import { DomainError } from "../domain/errors";
import { findOrdersByReference, matchMaterial } from "../domain/matching";
import { toMilli } from "../domain/quantity";
import { normalizeText } from "../domain/text";
import { unitCodeFromWord, type UnitSize } from "../domain/units";
import { allocatePayment, createOrder, createPayment, registerDelivery, type AllocationInput } from "../services/commands";
import type { CommandContext } from "../services/context";
import { buildDeliveryInterpretation, materialCandidates, resolveSupplierMention, withPaymentPreview } from "./proposals";

// Review step of the AI flow: the user edits a proposal (revise) and finally
// confirms it, which runs the same validated domain commands as manual forms.

// ------------------------------------------------------------------ revise

function reviseOrder(ledger: Ledger, i: OrderInterpretation): OrderInterpretation {
  let supplier = { id: i.supplierId, name: i.supplierName, status: i.supplierMatch, candidates: i.supplierCandidates };
  const current = i.supplierId ? ledger.supplier(i.supplierId) : undefined;
  if (!current || normalizeText(current.name) !== normalizeText(i.supplierName)) {
    const r = resolveSupplierMention(ledger, i.supplierName);
    supplier = { id: r.id, name: r.name, status: r.status, candidates: r.candidates.length ? r.candidates : undefined };
  }
  const catalog = materialCandidates(ledger);
  const items = i.items.map((it) => {
    const material = it.materialId ? ledger.material(it.materialId) : undefined;
    if (material && normalizeText(material.name) === normalizeText(it.material)) {
      return { ...it, material: material.name, match: it.match === "new" ? "matched" : it.match, spec: material.spec ?? undefined };
    }
    const exact = catalog.find((m) => normalizeText(m.name) === normalizeText(it.material) || m.aliases.some((a) => normalizeText(a) === normalizeText(it.material)));
    if (exact) {
      const unit = ledger.unitLabel(exact.baseUnit);
      return { ...it, materialId: exact.id, material: exact.name, match: "matched" as const, candidates: undefined, unit, unitSize: unit === it.unit ? it.unitSize : undefined, spec: ledger.material(exact.id)?.spec ?? undefined };
    }
    if (it.match === "new" && !it.materialId) return { ...it, candidates: undefined };
    const r = matchMaterial(it.material, catalog);
    if (r.status === "new") return { ...it, materialId: null, match: "new" as const, candidates: undefined, spec: undefined };
    return {
      ...it,
      materialId: r.best!.id,
      match: "suggested" as const,
      candidates: r.candidates.map((c) => ({ id: c.item.id, name: c.item.name, unit: ledger.unitLabel(c.item.baseUnit) })),
    };
  });
  const flags = i.flags.filter((f) => f !== "supplierName" && f !== "items");
  if (supplier.status !== "matched") flags.push("supplierName");
  if (items.some((x) => x.match === "suggested")) flags.push("items");
  return { ...i, supplierId: supplier.id, supplierName: supplier.name, supplierMatch: supplier.status, supplierCandidates: supplier.candidates, items, flags };
}

function reviseDelivery(ledger: Ledger, i: DeliveryInterpretation): DeliveryInterpretation {
  let order = ledger.order(i.orderId);
  if (!order || normalizeText(ledger.orderNumber(order)) !== normalizeText(i.orderNumber)) {
    const found = findOrdersByReference(i.orderNumber, ledger.s.orders, i.supplierId);
    const all = found.length ? found : findOrdersByReference(i.orderNumber, ledger.s.orders);
    if (all.length !== 1) throw new DomainError("order_unresolved", all.length ? `Hay varios pedidos ${i.orderNumber}; indica el proveedor.` : `No encontré el pedido ${i.orderNumber}.`);
    order = all[0]!;
  }
  // Keep what the user said arrived, per material, on the (possibly new) order.
  const byMaterial = new Map(i.items.filter((x) => x.materialId).map((x) => [x.materialId!, toMilli(x.now) ?? 0]));
  const requested = new Map<string, number>();
  for (const item of ledger.items(order.id)) if (byMaterial.has(item.materialId)) requested.set(item.id, byMaterial.get(item.materialId)!);
  const sameOrder = order.id === i.orderId;
  const { interpretation } = buildDeliveryInterpretation(ledger, order, sameOrder || requested.size ? requested : "all", {
    remito: i.remito,
    date: i.date,
    document: i.document,
    flags: sameOrder ? i.flags : i.flags.filter((f) => f !== "orderNumber"),
    completesOrder: i.completesOrder,
  });
  return interpretation;
}

/** "Todo lo pendiente" recomputed from current deliveries. */
export function refreshCompleteDelivery(ledger: Ledger, i: DeliveryInterpretation): DeliveryInterpretation {
  const order = ledger.order(i.orderId);
  if (!order) return i;
  return buildDeliveryInterpretation(ledger, order, "all", { remito: i.remito, date: i.date, document: i.document, flags: i.flags, completesOrder: true }).interpretation;
}

/**
 * Values the user saw and confirmed must still hold against current data;
 * otherwise the confirmation is rejected and a refreshed proposal is returned
 * for a new review. Never trust figures computed when the proposal was made.
 */
export function staleProposal(ledger: Ledger, submitted: Interpretation, final: Interpretation): { interpretation: Interpretation; message: string } | null {
  if (submitted.kind === "delivery" && final.kind === "delivery") {
    if (submitted.completesOrder) {
      const fresh = refreshCompleteDelivery(ledger, submitted);
      const same =
        fresh.items.length === submitted.items.length && fresh.items.every((f) => submitted.items.some((s) => s.orderLineId === f.orderLineId && s.now === f.now && s.before === f.before));
      if (!same) return { interpretation: fresh, message: `Lo pendiente del pedido ${submitted.orderNumber} cambió desde la propuesta. Revisa las cantidades actualizadas antes de confirmar.` };
      return null;
    }
    const changed = submitted.items.some((s) => s.now > 0 && final.items.find((f) => f.orderLineId === s.orderLineId)?.now !== s.now);
    if (changed) return { interpretation: final, message: `Las entregas del pedido ${submitted.orderNumber} cambiaron desde la propuesta. Revisa las cantidades actualizadas antes de confirmar.` };
  }
  if (submitted.kind === "payment" && final.kind === "payment" && submitted.paysOrderBalance && submitted.allocation.type === "order") {
    const order = ledger.order(submitted.allocation.orderId);
    const pending = order ? ledger.orderPending(order) : null;
    if (pending !== null && pending > 0 && pending !== submitted.amount) {
      return {
        interpretation: withPaymentPreview(ledger, { ...submitted, amount: pending }),
        message: `El saldo del pedido ${submitted.allocation.orderNumber} cambió desde la propuesta: ahora es ${formatMoney(pending)}. Revisa el importe antes de confirmar.`,
      };
    }
  }
  return null;
}

export function reviseInterpretation(ledger: Ledger, i: Interpretation): Interpretation {
  if (i.kind === "order") return reviseOrder(ledger, i);
  if (i.kind === "delivery") return reviseDelivery(ledger, i);
  return withPaymentPreview(ledger, i);
}

// ------------------------------------------------------------------ confirm

export interface ConfirmOutcome {
  result: ConfirmResult;
  entityType: "order" | "delivery" | "payment";
  entityId: string;
}

function unitCode(ledger: Ledger, label: string, material: string): string {
  const code = unitCodeFromWord(label, ledger.s.units);
  if (!code) throw new DomainError("validation", `No reconozco la unidad «${label}» de ${material}.`);
  return code;
}

function unitSizeOf(ledger: Ledger, it: OrderInterpretation["items"][number], unit: string): UnitSize | null {
  if (!it.unitSize) return null;
  const sizeUnit = unitCode(ledger, it.unitSize.unit, it.material);
  const milli = toMilli(it.unitSize.quantity);
  if (milli === null || milli <= 0) throw new DomainError("invalid_quantity", `La medida de ${it.material} no es válida.`);
  return sizeUnit === unit ? null : { milli, unit: sizeUnit };
}

async function confirmOrder(ctx: CommandContext, ledger: Ledger, i: OrderInterpretation, after: () => Promise<Ledger>): Promise<ConfirmOutcome> {
  const supplierName = i.supplierName.trim();
  const supplier = i.supplierId && ledger.supplier(i.supplierId) ? { id: i.supplierId } : supplierName ? { newName: supplierName } : null;
  if (!supplier) throw new DomainError("supplier_unresolved", "Falta el proveedor del pedido. Complétalo antes de confirmar.");
  if (!i.items.length) throw new DomainError("validation", "El pedido necesita al menos un material.");
  const items = i.items.map((it) => {
    const quantityMilli = toMilli(it.quantity);
    if (quantityMilli === null || quantityMilli <= 0) throw new DomainError("invalid_quantity", `La cantidad de ${it.material} no es válida.`);
    const material = it.materialId ? ledger.material(it.materialId) : undefined;
    if (!material && !it.material.trim()) throw new DomainError("material_unresolved", "Hay un ítem sin material. Complétalo o quítalo.");
    const unit = unitCode(ledger, it.unit, it.material);
    return {
      material: material ? { id: material.id } : { newName: it.material.trim(), unit },
      // The wording heard or printed ("HIERRO DIAM.12 X BARRA 12 MT") becomes an alias of the chosen material.
      mention: it.mention && (it.match !== "new" || !material) ? it.mention : undefined,
      description: material?.name ?? it.material.trim(),
      quantityMilli,
      unit,
      unitSize: unitSizeOf(ledger, it, unit),
      unitPriceMinor: it.unitPrice,
    };
  });
  const { orderId, number } = await createOrder(ctx, {
    supplier,
    reference: i.number.trim() || null,
    date: i.date,
    orderedByName: i.orderedBy || null,
    purchaseMode: i.mode,
    notes: i.notes ?? null,
    statedTotalMinor: i.statedTotal ?? null,
    items,
    documentIds: i.document?.documentId ? [i.document.documentId] : [],
  });
  const fresh = await after();
  const order = fresh.order(orderId)!;
  const total = fresh.orderValue(order);
  const name = fresh.supplierName(order.supplierId);
  return {
    entityType: "order",
    entityId: orderId,
    result: {
      recordId: `order:${orderId}`,
      title: `Pedido ${number} registrado`,
      subtitle: `${name} · ${formatDate(i.date)} · ${items.length} ${items.length === 1 ? "material" : "materiales"}`,
      link: { to: "/pedidos/$orderId", params: { orderId } },
      total: total ?? undefined,
      tags: ["entrega_pendiente", "sin_pagos"],
      documentName: i.document?.fileName,
    },
  };
}

function statusTags(ledger: Ledger, orderId: string): StatusTag[] {
  const order = ledger.order(orderId)!;
  const d = ledger.orderDeliveryStatus(order);
  const p = ledger.orderPaymentStatus(order);
  return [d === "entregado" ? "entregado" : d === "parcial" ? "entrega_parcial" : "entrega_pendiente", p === "pagado" ? "pagado" : p === "parcial" ? "pago_parcial" : "sin_pagos"];
}

async function confirmDelivery(ctx: CommandContext, i: DeliveryInterpretation, after: () => Promise<Ledger>): Promise<ConfirmOutcome> {
  const items = i.items
    .filter((it) => it.now !== 0)
    .map((it) => {
      const quantityMilli = toMilli(it.now);
      if (quantityMilli === null || quantityMilli <= 0) throw new DomainError("invalid_quantity", `La cantidad entregada de ${it.material} no es válida.`);
      return { orderItemId: it.orderLineId, quantityMilli };
    });
  const { deliveryId } = await registerDelivery(ctx, {
    orderId: i.orderId,
    date: i.date,
    reference: i.remito || null,
    items,
    documentIds: i.document?.documentId ? [i.document.documentId] : [],
  });
  const fresh = await after();
  const summary = fresh.toOrderSummary(fresh.order(i.orderId)!);
  return {
    entityType: "delivery",
    entityId: deliveryId,
    result: {
      recordId: `delivery:${deliveryId}`,
      title: "Entrega registrada",
      subtitle: `Pedido ${summary.number} · ${summary.supplier.name} · ${deliveryAmountLabel(summary.delivery)}`,
      link: { to: "/pedidos/$orderId", params: { orderId: i.orderId } },
      tags: statusTags(fresh, i.orderId),
      documentName: i.document?.fileName,
    },
  };
}

/** Allocations implied by the proposal, recomputed from current balances (never above an order's known balance). */
export function allocationsFor(ledger: Ledger, i: PaymentInterpretation): AllocationInput[] {
  if (i.allocation.type === "unallocated") return [];
  if (i.allocation.type === "split") return i.allocation.parts.map((p) => ({ orderId: p.orderId, amountMinor: p.amount }));
  const order = ledger.order(i.allocation.orderId);
  if (!order) throw new DomainError("order_unresolved", `El pedido ${i.allocation.orderNumber} ya no existe.`);
  const pending = ledger.orderPending(order);
  const amount = pending === null ? i.amount : Math.min(i.amount, pending);
  return amount > 0 ? [{ orderId: order.id, amountMinor: amount }] : [];
}

async function confirmPayment(ctx: CommandContext, ledger: Ledger, i: PaymentInterpretation, after: () => Promise<Ledger>): Promise<ConfirmOutcome> {
  if (!Number.isSafeInteger(i.amount) || i.amount <= 0) throw new DomainError("invalid_amount", "El importe del pago debe ser mayor que cero.");
  const allocations = allocationsFor(ledger, i);
  const orderId = allocations.length === 1 ? allocations[0]!.orderId : undefined;
  if (i.existingPaymentId) {
    if (!allocations.length) throw new DomainError("validation", "Elige el pedido al que se imputa el pago.");
    const { allocationIds } = await allocatePayment(ctx, i.existingPaymentId, allocations);
    const fresh = await after();
    return {
      entityType: "payment",
      entityId: i.existingPaymentId,
      result: {
        recordId: `allocation:${i.existingPaymentId}:${allocationIds.join(",")}`,
        title: "Pago imputado",
        subtitle: allocations.map((a) => `${formatMoney(a.amountMinor)} al pedido ${fresh.orderNumber(fresh.order(a.orderId)!)}`).join(" · ") + ` · ${i.supplierName}`,
        link: orderId ? { to: "/pedidos/$orderId", params: { orderId } } : { to: "/proveedores/$supplierId", params: { supplierId: i.supplierId } },
        tags: orderId ? [statusTags(fresh, orderId)[1]!] : [],
      },
    };
  }
  const { paymentId } = await createPayment(ctx, {
    supplierId: i.supplierId,
    date: i.date,
    amountMinor: i.amount,
    method: i.method,
    reference: i.reference ?? null,
    allocations,
    documentIds: i.document?.documentId ? [i.document.documentId] : [],
  });
  const fresh = await after();
  const allocated = allocations.reduce((s, a) => s + a.amountMinor, 0);
  const tags: StatusTag[] = orderId ? [statusTags(fresh, orderId)[1]!] : [];
  if (allocated < i.amount) tags.push("pago_sin_imputar");
  return {
    entityType: "payment",
    entityId: paymentId,
    result: {
      recordId: `payment:${paymentId}`,
      title: "Pago registrado",
      subtitle: `${formatMoney(i.amount)} · ${i.supplierName} · ${paymentMethodLabel[i.method]}`,
      link: orderId ? { to: "/pedidos/$orderId", params: { orderId } } : { to: "/proveedores/$supplierId", params: { supplierId: i.supplierId } },
      tags,
      documentName: i.document?.fileName,
    },
  };
}

export async function confirmInterpretation(ctx: CommandContext, ledger: Ledger, i: Interpretation, reload: () => Promise<Ledger>): Promise<ConfirmOutcome> {
  if (i.kind === "order") return confirmOrder(ctx, ledger, i, reload);
  if (i.kind === "delivery") return confirmDelivery(ctx, i, reload);
  return confirmPayment(ctx, ledger, i, reload);
}
