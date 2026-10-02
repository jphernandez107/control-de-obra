import { and, desc, eq } from "drizzle-orm";
import type { Interpretation, InterpretationValidation } from "../../src/domain/assistant";
import { formatMoney, formatNumber } from "../../src/domain/format";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import type { Ledger } from "../domain/derive";
import { toMilli } from "../domain/quantity";
import { unitCodeFromWord } from "../domain/units";
import { allocationsFor } from "./review";

// Pending AI actions: proposals waiting for review. They live in
// `ai_interpretations`; this module is their application-facing model and
// the server-side validation that runs on creation, on every edit and again
// right before confirmation. An unconfirmed action is never project history.

type Issue = InterpretationValidation["issues"][number];

const error = (field: string, message: string): Issue => ({ field, message, severity: "error" });
const warning = (field: string, message: string): Issue => ({ field, message, severity: "warning" });

function validateOrder(ledger: Ledger, i: Extract<Interpretation, { kind: "order" }>): Issue[] {
  const issues: Issue[] = [];
  if (!i.supplierName.trim()) issues.push(error("supplierName", "Falta el proveedor."));
  else if (i.supplierMatch === "suggested") issues.push(warning("supplierName", `Verifica el proveedor: ¿es ${i.supplierName}?`));
  else if (!i.supplierId) issues.push(warning("supplierName", `${i.supplierName} es un proveedor nuevo: se agregará al confirmar.`));
  if (!i.items.length) issues.push(error("items", "El pedido necesita al menos un material."));
  for (const it of i.items) {
    if (!it.material.trim()) issues.push(error("items", "Hay un ítem sin material."));
    const q = toMilli(it.quantity);
    if (q === null || q <= 0) issues.push(error("items", `La cantidad de ${it.material || "un ítem"} no es válida.`));
    if (!unitCodeFromWord(it.unit, ledger.s.units)) issues.push(error("items", `No reconozco la unidad «${it.unit}» de ${it.material}.`));
    if (it.match === "suggested") issues.push(warning("items", `Confirma el material: ¿«${it.mention ?? it.material}» es ${it.material}?`));
    else if (it.match === "new" && !it.materialId) issues.push(warning("items", `${it.material} es un material nuevo: se agregará al catálogo.`));
  }
  if (i.statedTotal == null && i.items.some((it) => it.unitPrice === null)) issues.push(warning("amount", "Sin precios completos: el importe del pedido quedará a confirmar."));
  return issues;
}

function validateDelivery(ledger: Ledger, i: Extract<Interpretation, { kind: "delivery" }>): Issue[] {
  const issues: Issue[] = [];
  const order = ledger.order(i.orderId);
  if (!order) return [error("orderNumber", `El pedido ${i.orderNumber} ya no existe o fue anulado.`)];
  if (i.flags.includes("orderNumber")) issues.push(warning("orderNumber", `Verifica que la entrega sea del pedido ${i.orderNumber}.`));
  if (!i.items.some((it) => it.now > 0)) issues.push(error("items", "Indica al menos una cantidad entregada."));
  for (const it of i.items) {
    const item = ledger.orderItem(it.orderLineId);
    const now = toMilli(it.now);
    if (!item || item.orderId !== order.id) issues.push(error("items", `${it.material} no es parte del pedido ${i.orderNumber}.`));
    else if (now === null || now < 0) issues.push(error("items", `La cantidad entregada de ${it.material} no es válida.`));
    else if (now > ledger.remainingMilli(item)) issues.push(error("items", `${it.material}: solo faltan ${formatNumber(ledger.remainingMilli(item) / 1000)} ${it.unit}.`));
  }
  return issues;
}

function validatePayment(ledger: Ledger, i: Extract<Interpretation, { kind: "payment" }>): Issue[] {
  const issues: Issue[] = [];
  if (!ledger.supplier(i.supplierId)) issues.push(error("supplierName", "Falta el proveedor del pago."));
  if (!Number.isSafeInteger(i.amount) || i.amount <= 0) issues.push(error("amount", "Falta el importe del pago."));
  if (i.allocation.type === "order") {
    const order = ledger.order(i.allocation.orderId);
    if (!order) issues.push(error("allocation", `El pedido ${i.allocation.orderNumber} ya no existe o fue anulado.`));
    else if (i.paysOrderBalance && ledger.orderPending(order) === null) issues.push(error("amount", `El pedido ${i.allocation.orderNumber} no tiene importe cargado: indica cuánto se pagó.`));
  }
  if (i.allocation.type === "split") {
    const total = i.allocation.parts.reduce((s, p) => s + p.amount, 0);
    if (total > i.amount) issues.push(error("allocation", `Las partes (${formatMoney(total)}) suman más que el pago.`));
    for (const p of i.allocation.parts) {
      const order = ledger.order(p.orderId);
      const pending = order ? ledger.orderPending(order) : null;
      if (!order) issues.push(error("allocation", `El pedido ${p.orderNumber} ya no existe o fue anulado.`));
      else if (pending !== null && p.amount > pending) issues.push(error("allocation", `Al pedido ${p.orderNumber} le faltan ${formatMoney(pending)}; no se le puede imputar más.`));
    }
  }
  if (i.existingPaymentId) {
    const payment = ledger.s.payments.find((p) => p.id === i.existingPaymentId);
    if (!payment) issues.push(error("allocation", "El pago a imputar ya no existe."));
    else if (allocationsFor(ledger, i).reduce((s, a) => s + a.amountMinor, 0) > ledger.paymentUnallocated(payment)) issues.push(error("allocation", "El pago no tiene tanto sin imputar."));
  }
  if (i.flags.includes("allocation") && i.allocation.type === "order") issues.push(warning("allocation", `Verifica que el pago corresponda al pedido ${i.allocation.orderNumber}.`));
  return issues;
}

export function validateInterpretation(ledger: Ledger, i: Interpretation): InterpretationValidation {
  const issues = i.kind === "order" ? validateOrder(ledger, i) : i.kind === "delivery" ? validateDelivery(ledger, i) : validatePayment(ledger, i);
  const state = issues.some((x) => x.severity === "error") ? "blocked" : issues.length ? "needs_review" : "ready";
  return { state, issues };
}

/** Returns the interpretation with its validation attached (the UI shows it on the card). */
export function withValidation<T extends Interpretation>(ledger: Ledger, i: T): T {
  return { ...i, validation: validateInterpretation(ledger, i) };
}

export function unresolvedFields(v: InterpretationValidation): string[] {
  return [...new Set(v.issues.filter((x) => x.severity === "error" || /Verifica|Confirma/.test(x.message)).map((x) => x.field))];
}

// ------------------------------------------------------------------ model

export type PendingActionStatus = "pending" | "confirmed" | "cancelled" | "undone";

export interface PendingAIAction {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  sourceDocumentIds: string[];
  intent: string;
  proposal: Interpretation;
  validationState: InterpretationValidation["state"] | null;
  warnings: string[];
  unresolvedFields: string[];
  status: PendingActionStatus;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  provider: { name: string; model: string | null; confidence: number | null };
}

type Row = typeof t.aiInterpretations.$inferSelect;

function jsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function toPendingAIAction(row: Row): PendingAIAction {
  const status = row.status as PendingActionStatus;
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    sourceDocumentIds: row.documentId ? [row.documentId] : [],
    intent: row.intent,
    proposal: JSON.parse(row.confirmedProposal ?? row.proposal) as Interpretation,
    validationState: (row.validationState as PendingAIAction["validationState"]) ?? null,
    warnings: jsonArray(row.warnings),
    unresolvedFields: jsonArray(row.unresolvedFields),
    status,
    createdAt: row.createdAt,
    confirmedAt: status === "confirmed" || status === "undone" ? row.resolvedAt : null,
    cancelledAt: status === "cancelled" ? row.resolvedAt : null,
    provider: { name: row.provider, model: row.model, confidence: row.confidence === null ? null : row.confidence / 100 },
  };
}

/** Columns that mirror a proposal's validation, for storage. */
export function validationColumns(v: InterpretationValidation | undefined) {
  if (!v) return { validationState: null, warnings: null, unresolvedFields: null };
  return {
    validationState: v.state,
    warnings: JSON.stringify(v.issues.filter((x) => x.severity === "warning").map((x) => x.message)),
    unresolvedFields: JSON.stringify(unresolvedFields(v)),
  };
}

export async function listPendingActions(db: AppDb, projectId: string, status: PendingActionStatus = "pending"): Promise<PendingAIAction[]> {
  const rows = await db
    .select()
    .from(t.aiInterpretations)
    .where(and(eq(t.aiInterpretations.projectId, projectId), eq(t.aiInterpretations.status, status)))
    .orderBy(desc(t.aiInterpretations.createdAt))
    .limit(100);
  return rows.map(toPendingAIAction);
}
