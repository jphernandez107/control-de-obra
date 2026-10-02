import { and, eq, isNull, max } from "drizzle-orm";
import * as t from "../db/schema";
import { Ledger } from "../domain/derive";
import { assert, DomainError } from "../domain/errors";
import { lineTotalMinor } from "../domain/money";
import { fromMilli } from "../domain/quantity";
import { normalizeReference, normalizeText } from "../domain/text";
import { isValidDate } from "../domain/time";
import { formatMoney, formatNumber, paymentMethodLabel } from "../../src/domain/format";
import type { ActivityChange, PaymentMethod, StatusTag } from "../../src/domain/types";
import { loadSnapshot } from "../repositories/snapshot";
import { newId, WriteSet, type CommandContext } from "./context";

// Validated domain commands. Each one re-reads current state, checks the
// business rules, and writes records + audit entries in one atomic batch.
// Callers (HTTP handlers, the AI confirmation step) pass already-parsed input.

export type DocumentKindCode = "order_proof" | "delivery_proof" | "payment_proof" | "computation" | "other";

export async function snapshotFor(ctx: CommandContext): Promise<Ledger> {
  return new Ledger(await loadSnapshot(ctx.db, ctx.projectId, ""));
}

function checkDate(value: string, label: string) {
  assert(isValidDate(value), "validation", `La fecha de ${label} no es válida.`);
}

function checkQuantity(milli: number, label: string) {
  assert(Number.isSafeInteger(milli) && milli > 0, "invalid_quantity", `La cantidad de ${label} debe ser mayor que cero.`);
}

function checkUnit(ledger: Ledger, unit: string) {
  assert(ledger.s.units.some((u) => u.code === unit), "validation", `La unidad «${unit}» no existe.`);
}

function qtyLabel(ledger: Ledger, milli: number, unit: string) {
  return `${formatNumber(fromMilli(milli))} ${ledger.unitLabel(unit)}`;
}

// ------------------------------------------------------------------ catalog

export type SupplierRefInput = { id: string } | { newName: string; category?: string };
export type MaterialRefInput = { id: string } | { newName: string; unit: string; category?: string; spec?: string };

/** Existing supplier or a new one. A new name equal (normalized) to an existing supplier reuses it. */
function resolveSupplier(ws: WriteSet, ctx: CommandContext, ledger: Ledger, ref: SupplierRefInput, created: Map<string, string>): string {
  if ("id" in ref) {
    assert(ledger.supplier(ref.id), "supplier_unresolved", "El proveedor indicado no existe.");
    return ref.id;
  }
  const name = ref.newName.trim();
  assert(name.length >= 2, "supplier_unresolved", "Falta el nombre del proveedor.");
  const normalized = normalizeText(name);
  const existing = ledger.s.suppliers.find((s) => s.normalizedName === normalized);
  if (existing) return existing.id;
  const pending = created.get(`s:${normalized}`);
  if (pending) return pending;
  const id = newId();
  created.set(`s:${normalized}`, id);
  ws.add(
    ctx.db.insert(t.suppliers).values({
      id,
      projectId: ctx.projectId,
      name,
      normalizedName: normalized,
      category: ref.category ?? "Varios",
      aliases: "[]",
      createdAt: ws.stamp,
      updatedAt: ws.stamp,
    }),
  );
  ws.audit({ action: "supplier.created", entityType: "supplier", entityId: id, summary: `${name} · nuevo proveedor`, supplierId: id });
  return id;
}

function resolveMaterial(ws: WriteSet, ctx: CommandContext, ledger: Ledger, ref: MaterialRefInput, supplierId: string, created: Map<string, string>): string {
  if ("id" in ref) {
    assert(ledger.material(ref.id), "material_unresolved", "El material indicado no existe en el catálogo.");
    return ref.id;
  }
  const name = ref.newName.trim();
  assert(name.length >= 2, "material_unresolved", "Falta el nombre del material.");
  checkUnit(ledger, ref.unit);
  const normalized = normalizeText(name);
  const existing = ledger.s.materials.find((m) => m.normalizedName === normalized);
  if (existing) return existing.id;
  const pending = created.get(`m:${normalized}`);
  if (pending) return pending;
  const id = newId();
  created.set(`m:${normalized}`, id);
  const supplier = ledger.supplier(supplierId);
  ws.add(
    ctx.db.insert(t.materials).values({
      id,
      projectId: ctx.projectId,
      name,
      normalizedName: normalized,
      shortName: name,
      spec: ref.spec ?? null,
      baseUnit: ref.unit,
      category: ref.category ?? supplier?.category ?? "Varios",
      usualSupplierId: ledger.supplier(supplierId) ? supplierId : null,
      active: true,
      createdAt: ws.stamp,
      updatedAt: ws.stamp,
    }),
  );
  ws.audit({ action: "material.created", entityType: "material", entityId: id, summary: `${name} · unidad ${ledger.unitLabel(ref.unit)}` });
  return id;
}

/** Remembers a confirmed wording ("hierro del 12") for a material, so the next match is strong. */
function learnAlias(ws: WriteSet, ctx: CommandContext, ledger: Ledger, materialId: string, alias: string | undefined, learned: Set<string>) {
  if (!alias || !ledger.material(materialId)) return;
  const normalized = normalizeText(alias);
  if (normalized.length < 2 || learned.has(normalized)) return;
  const material = ledger.material(materialId)!;
  if (material.normalizedName === normalized) return;
  if (ledger.s.aliases.some((a) => a.normalizedAlias === normalized)) return;
  learned.add(normalized);
  ws.add(
    ctx.db.insert(t.materialAliases).values({
      id: newId(),
      projectId: ctx.projectId,
      materialId,
      alias: alias.trim(),
      normalizedAlias: normalized,
      source: "confirmed",
      createdAt: ws.stamp,
    }),
  );
  ws.audit({ action: "material.alias_added", entityType: "material", entityId: materialId, summary: `«${alias.trim()}» → ${material.name}` });
}

// ------------------------------------------------------------------ documents

function linkDocuments(
  ws: WriteSet,
  ctx: CommandContext,
  ledger: Ledger,
  documentIds: string[] | undefined,
  target: { orderId?: string; deliveryId?: string; paymentId?: string },
  meta: { kind: DocumentKindCode; supplierId: string; date?: string; label: string; orderId?: string | null },
) {
  for (const documentId of documentIds ?? []) {
    const doc = ledger.s.documents.find((d) => d.id === documentId);
    assert(doc, "not_found", "El documento adjunto no existe.");
    ws.add(
      ctx.db.insert(t.documentLinks).values({
        id: newId(),
        documentId,
        orderId: target.orderId ?? null,
        deliveryId: target.deliveryId ?? null,
        paymentId: target.paymentId ?? null,
        createdBy: ctx.actor.userId,
        createdAt: ws.stamp,
      }),
    );
    ws.add(
      ctx.db
        .update(t.documents)
        .set({ kind: doc.kind === "other" ? meta.kind : doc.kind, supplierId: doc.supplierId ?? meta.supplierId, documentDate: doc.documentDate ?? meta.date ?? null })
        .where(eq(t.documents.id, documentId)),
    );
    const kindLabel = { order_proof: "Comprobante de pedido", delivery_proof: "Remito", payment_proof: "Comprobante de pago", computation: "Cómputo", other: "Documento" }[meta.kind];
    ws.audit({
      action: "document.attached",
      entityType: "document",
      entityId: documentId,
      summary: `${doc.fileName} · ${kindLabel} · ${meta.label}`,
      shortSummary: `${doc.fileName} · ${kindLabel}`,
      supplierId: meta.supplierId,
      orderId: meta.orderId ?? target.orderId ?? null,
    });
  }
}

export async function attachDocument(ctx: CommandContext, input: { documentId: string; orderId?: string; deliveryId?: string; paymentId?: string }) {
  const ledger = await snapshotFor(ctx);
  const ws = new WriteSet(ctx);
  let supplierId: string;
  let kind: DocumentKindCode;
  let orderId: string | null = null;
  let label: string;
  if (input.orderId) {
    const order = ledger.order(input.orderId);
    assert(order, "not_found", "El pedido no existe.");
    supplierId = order.supplierId;
    kind = "order_proof";
    orderId = order.id;
    label = `Pedido ${ledger.orderNumber(order)} · ${ledger.supplierName(supplierId)}`;
  } else if (input.deliveryId) {
    const d = ledger.s.deliveries.find((x) => x.id === input.deliveryId);
    assert(d, "not_found", "La entrega no existe.");
    supplierId = d.supplierId;
    kind = "delivery_proof";
    orderId = d.orderId;
    label = ledger.supplierName(supplierId);
  } else if (input.paymentId) {
    const p = ledger.s.payments.find((x) => x.id === input.paymentId);
    assert(p, "not_found", "El pago no existe.");
    supplierId = p.supplierId;
    kind = "payment_proof";
    label = ledger.supplierName(supplierId);
  } else throw new DomainError("validation", "Indica a qué registro se adjunta el documento.");
  assert(
    !ledger.s.documentLinks.some((l) => l.documentId === input.documentId && l.orderId == (input.orderId ?? null) && l.deliveryId == (input.deliveryId ?? null) && l.paymentId == (input.paymentId ?? null)),
    "duplicate",
    "El documento ya está adjunto a ese registro.",
  );
  linkDocuments(ws, ctx, ledger, [input.documentId], input, { kind, supplierId, label, orderId });
  await ws.commit();
}

// ------------------------------------------------------------------ orders

export interface CreateOrderInput {
  supplier: SupplierRefInput;
  reference?: string | null;
  date: string;
  orderedByName?: string | null;
  purchaseMode: "cuenta_corriente" | "contado";
  notes?: string | null;
  statedTotalMinor?: number | null;
  items: {
    material: MaterialRefInput;
    /** Wording to remember as an alias of the chosen material. */
    mention?: string;
    description?: string;
    quantityMilli: number;
    unit: string;
    unitPriceMinor?: number | null;
  }[];
  documentIds?: string[];
}

export async function createOrder(ctx: CommandContext, input: CreateOrderInput): Promise<{ orderId: string; number: string }> {
  const ledger = await snapshotFor(ctx);
  checkDate(input.date, "pedido");
  assert(input.items.length > 0, "validation", "El pedido necesita al menos un material.");
  assert(input.statedTotalMinor == null || (Number.isSafeInteger(input.statedTotalMinor) && input.statedTotalMinor >= 0), "invalid_amount", "El total del pedido no es válido.");
  const ws = new WriteSet(ctx);
  const created = new Map<string, string>();
  const learned = new Set<string>();
  const supplierId = resolveSupplier(ws, ctx, ledger, input.supplier, created);
  const reference = input.reference?.trim() || null;
  if (reference) {
    const normalized = normalizeReference(reference);
    const clash = ledger.s.orders.find((o) => o.supplierId === supplierId && o.normalizedReference === normalized);
    assert(!clash, "duplicate", `Ya existe el pedido ${reference} de ${ledger.supplierName(supplierId)}.`);
  }
  const [{ value: maxNumber } = { value: 0 }] = await ctx.db
    .select({ value: max(t.orders.internalNumber) })
    .from(t.orders)
    .where(eq(t.orders.projectId, ctx.projectId));
  const internalNumber = (maxNumber ?? 0) + 1;
  const orderId = newId();
  const orderedBy = input.orderedByName?.trim() || null;
  const orderedByUser = orderedBy
    ? ledger.s.users.find((u) => normalizeText(u.name) === normalizeText(orderedBy) || normalizeText(u.name).split(" ")[0] === normalizeText(orderedBy))
    : undefined;
  ws.add(
    ctx.db.insert(t.orders).values({
      id: orderId,
      projectId: ctx.projectId,
      supplierId,
      internalNumber,
      reference,
      normalizedReference: reference ? normalizeReference(reference) : null,
      orderDate: input.date,
      orderedByName: orderedByUser?.name ?? orderedBy,
      orderedByUserId: orderedByUser?.id ?? null,
      purchaseMode: input.purchaseMode,
      currency: ledger.s.project.currency,
      statedTotalMinor: input.statedTotalMinor ?? null,
      notes: input.notes?.trim() || null,
      source: ctx.source,
      createdBy: ctx.actor.userId,
      createdAt: ws.stamp,
      updatedAt: ws.stamp,
    }),
  );
  let total: number | null = 0;
  input.items.forEach((item, position) => {
    const materialId = resolveMaterial(ws, ctx, ledger, item.material, supplierId, created);
    const materialName = ledger.material(materialId)?.name ?? ("newName" in item.material ? item.material.newName : "Material");
    checkQuantity(item.quantityMilli, materialName);
    checkUnit(ledger, item.unit);
    const price = item.unitPriceMinor ?? null;
    assert(price === null || (Number.isSafeInteger(price) && price >= 0), "invalid_amount", `El precio de ${materialName} no es válido.`);
    const lineTotal = price === null ? null : lineTotalMinor(price, item.quantityMilli);
    total = total === null || lineTotal === null ? null : total + lineTotal;
    ws.add(
      ctx.db.insert(t.orderItems).values({
        id: newId(),
        orderId,
        materialId,
        description: item.description?.trim() || materialName,
        quantityMilli: item.quantityMilli,
        unit: item.unit,
        unitPriceMinor: price,
        lineTotalMinor: lineTotal,
        position,
      }),
    );
    if ("id" in item.material) learnAlias(ws, ctx, ledger, materialId, item.mention, learned);
  });
  const value = input.statedTotalMinor ?? total;
  const number = reference ?? `#${internalNumber}`;
  const supplierName = ledger.supplier(supplierId)?.name ?? ("newName" in input.supplier ? input.supplier.newName : "");
  const hasDocs = Boolean(input.documentIds?.length);
  ws.audit({
    action: "order.created",
    entityType: "order",
    entityId: orderId,
    summary: `Pedido ${number} · ${supplierName} · ${input.items.length} ${input.items.length === 1 ? "material" : "materiales"} · ${value === null ? "importe a confirmar" : formatMoney(value)}`,
    shortSummary: `Pedido ${number} · ${supplierName}${value === null ? " · sin importe" : ""}`,
    tags: ["entrega_pendiente", "sin_pagos", ...(hasDocs ? [] : (["sin_comprobante"] as StatusTag[]))],
    supplierId,
    orderId,
  });
  linkDocuments(ws, ctx, ledger, input.documentIds, { orderId }, { kind: "order_proof", supplierId, date: input.date, label: supplierName, orderId });
  await ws.commit();
  return { orderId, number };
}

export interface CorrectOrderInput {
  reference?: string | null;
  date?: string;
  orderedByName?: string | null;
  purchaseMode?: "cuenta_corriente" | "contado";
  notes?: string | null;
  statedTotalMinor?: number | null;
  items?: { id: string; quantityMilli?: number; unitPriceMinor?: number | null }[];
  reason?: string | null;
}

/** Corrects an order. Previous values stay in the audit log; quantities can't drop below what was delivered. */
export async function correctOrder(ctx: CommandContext, orderId: string, input: CorrectOrderInput): Promise<void> {
  const ledger = await snapshotFor(ctx);
  const order = ledger.order(orderId);
  assert(order, "not_found", "El pedido no existe o fue deshecho.");
  const ws = new WriteSet(ctx);
  const changes: ActivityChange[] = [];
  const patch: Partial<typeof t.orders.$inferInsert> = {};
  const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatMoney(v));

  if (input.reference !== undefined) {
    const reference = input.reference?.trim() || null;
    if (reference !== order.reference) {
      if (reference) {
        const n = normalizeReference(reference);
        assert(!ledger.s.orders.some((o) => o.id !== order.id && o.supplierId === order.supplierId && o.normalizedReference === n), "duplicate", `Ya existe el pedido ${reference} de ${ledger.supplierName(order.supplierId)}.`);
      }
      patch.reference = reference;
      patch.normalizedReference = reference ? normalizeReference(reference) : null;
      changes.push({ label: "N.º de pedido", before: order.reference ?? "—", after: reference ?? "—" });
    }
  }
  if (input.date !== undefined && input.date !== order.orderDate) {
    checkDate(input.date, "pedido");
    patch.orderDate = input.date;
    changes.push({ label: "Fecha", before: order.orderDate, after: input.date });
  }
  if (input.orderedByName !== undefined && (input.orderedByName?.trim() || null) !== order.orderedByName) {
    patch.orderedByName = input.orderedByName?.trim() || null;
    patch.orderedByUserId = ledger.s.users.find((u) => patch.orderedByName && normalizeText(u.name) === normalizeText(patch.orderedByName))?.id ?? null;
    changes.push({ label: "Pedido por", before: order.orderedByName ?? "—", after: patch.orderedByName ?? "—" });
  }
  if (input.purchaseMode !== undefined && input.purchaseMode !== order.purchaseMode) {
    patch.purchaseMode = input.purchaseMode;
    changes.push({ label: "Modalidad", before: order.purchaseMode, after: input.purchaseMode });
  }
  if (input.notes !== undefined && (input.notes?.trim() || null) !== order.notes) {
    patch.notes = input.notes?.trim() || null;
    changes.push({ label: "Notas", before: order.notes ? "anterior" : "—", after: patch.notes ? "actualizada" : "—" });
  }
  if (input.statedTotalMinor !== undefined && input.statedTotalMinor !== order.statedTotalMinor) {
    assert(input.statedTotalMinor === null || (Number.isSafeInteger(input.statedTotalMinor) && input.statedTotalMinor >= 0), "invalid_amount", "El total del pedido no es válido.");
    patch.statedTotalMinor = input.statedTotalMinor;
    changes.push({ label: "Total informado", before: money(order.statedTotalMinor), after: money(input.statedTotalMinor) });
  }
  for (const change of input.items ?? []) {
    const item = ledger.items(order.id).find((i) => i.id === change.id);
    assert(item, "not_found", "Uno de los materiales no pertenece al pedido.");
    const material = ledger.material(item.materialId)?.name ?? item.description;
    const itemPatch: Partial<typeof t.orderItems.$inferInsert> = {};
    const quantity = change.quantityMilli ?? item.quantityMilli;
    if (change.quantityMilli !== undefined && change.quantityMilli !== item.quantityMilli) {
      checkQuantity(change.quantityMilli, material);
      const delivered = ledger.deliveredMilli(item.id);
      assert(change.quantityMilli >= delivered, "invalid_quantity", `No se puede pedir menos de lo ya entregado de ${material} (${qtyLabel(ledger, delivered, item.unit)}).`);
      itemPatch.quantityMilli = change.quantityMilli;
      changes.push({ label: `Cantidad ${material}`, before: qtyLabel(ledger, item.quantityMilli, item.unit), after: qtyLabel(ledger, change.quantityMilli, item.unit) });
    }
    const price = change.unitPriceMinor === undefined ? item.unitPriceMinor : change.unitPriceMinor;
    if (change.unitPriceMinor !== undefined && change.unitPriceMinor !== item.unitPriceMinor) {
      assert(price === null || (Number.isSafeInteger(price) && price >= 0), "invalid_amount", `El precio de ${material} no es válido.`);
      itemPatch.unitPriceMinor = price;
      changes.push({ label: `Precio ${material}`, before: money(item.unitPriceMinor), after: money(price) });
    }
    if (Object.keys(itemPatch).length) {
      itemPatch.lineTotalMinor = price === null ? null : lineTotalMinor(price, quantity);
      ws.add(ctx.db.update(t.orderItems).set(itemPatch).where(eq(t.orderItems.id, item.id)));
    }
  }
  if (!changes.length) return;
  // A lower order value must still cover what was already allocated to it.
  const items = ledger.items(order.id).map((i) => {
    const c = input.items?.find((x) => x.id === i.id);
    const price = c?.unitPriceMinor === undefined ? i.unitPriceMinor : c.unitPriceMinor;
    const qty = c?.quantityMilli ?? i.quantityMilli;
    return price === null ? null : lineTotalMinor(price, qty);
  });
  const stated = patch.statedTotalMinor !== undefined ? patch.statedTotalMinor : order.statedTotalMinor;
  const newValue = stated ?? (items.some((x) => x === null) ? null : items.reduce<number>((s, x) => s + (x ?? 0), 0));
  const paid = ledger.orderPaid(order.id);
  assert(newValue === null || newValue >= paid, "allocation_exceeds_order", `El nuevo importe (${formatMoney(newValue ?? 0)}) es menor que lo ya imputado al pedido (${formatMoney(paid)}).`);
  patch.updatedAt = ws.stamp;
  ws.add(ctx.db.update(t.orders).set(patch).where(eq(t.orders.id, order.id)));
  const number = patch.reference !== undefined ? patch.reference ?? `#${order.internalNumber}` : ledger.orderNumber(order);
  ws.audit({
    action: "order.corrected",
    entityType: "order",
    entityId: order.id,
    summary: `Pedido ${number} · ${ledger.supplierName(order.supplierId)} · por ${ctx.actor.name}`,
    changes,
    reason: input.reason?.trim() || undefined,
    supplierId: order.supplierId,
    orderId: order.id,
  });
  await ws.commit();
}

// ------------------------------------------------------------------ deliveries

export interface RegisterDeliveryInput {
  orderId?: string | null;
  supplierId?: string;
  date: string;
  reference?: string | null;
  notes?: string | null;
  items: { orderItemId?: string | null; materialId?: string; quantityMilli: number; unit?: string }[];
  documentIds?: string[];
}

/**
 * Records material that physically arrived. Payment state is untouched.
 * Delivering more than what remains on an order line is rejected.
 */
export async function registerDelivery(ctx: CommandContext, input: RegisterDeliveryInput): Promise<{ deliveryId: string; orderId: string | null }> {
  const ledger = await snapshotFor(ctx);
  checkDate(input.date, "entrega");
  const order = input.orderId ? ledger.order(input.orderId) : undefined;
  if (input.orderId) assert(order, "order_unresolved", "El pedido de esta entrega no existe o fue deshecho.");
  const supplierId = order?.supplierId ?? input.supplierId;
  assert(supplierId && ledger.supplier(supplierId), "supplier_unresolved", "Falta el proveedor de la entrega.");
  const items = input.items.filter((i) => i.quantityMilli !== 0);
  assert(items.length > 0, "invalid_quantity", "Indica al menos un material con cantidad entregada.");
  const ws = new WriteSet(ctx);
  const deliveryId = newId();
  ws.add(
    ctx.db.insert(t.deliveries).values({
      id: deliveryId,
      projectId: ctx.projectId,
      supplierId,
      orderId: order?.id ?? null,
      deliveryDate: input.date,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      source: ctx.source,
      createdBy: ctx.actor.userId,
      createdAt: ws.stamp,
      updatedAt: ws.stamp,
    }),
  );
  const described: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    let materialId: string;
    let unit: string;
    let name: string;
    if (it.orderItemId) {
      assert(order, "order_unresolved", "Para entregar un ítem de pedido hay que indicar el pedido.");
      const item = ledger.items(order.id).find((x) => x.id === it.orderItemId);
      assert(item, "validation", "Uno de los materiales no pertenece a este pedido.");
      assert(!seen.has(item.id), "validation", "Un material aparece repetido en la entrega.");
      seen.add(item.id);
      materialId = item.materialId;
      unit = item.unit;
      name = ledger.material(materialId)?.shortName ?? item.description;
      checkQuantity(it.quantityMilli, name);
      const remaining = ledger.remainingMilli(item);
      if (it.quantityMilli > remaining) {
        throw new DomainError(
          "over_delivery",
          remaining === 0
            ? `${name}: el pedido ${ledger.orderNumber(order)} ya está entregado completo. Si llegó de más, regístralo como otro pedido.`
            : `${name}: llegan ${qtyLabel(ledger, it.quantityMilli, unit)} pero solo faltan ${qtyLabel(ledger, remaining, unit)} del pedido ${ledger.orderNumber(order)}. Corrige la cantidad o registra el excedente como otro pedido.`,
        );
      }
    } else {
      assert(it.materialId && ledger.material(it.materialId), "material_unresolved", "Falta identificar el material entregado.");
      materialId = it.materialId;
      unit = it.unit ?? ledger.material(materialId)!.baseUnit;
      checkUnit(ledger, unit);
      name = ledger.material(materialId)!.shortName;
      checkQuantity(it.quantityMilli, name);
    }
    ws.add(ctx.db.insert(t.deliveryItems).values({ id: newId(), deliveryId, orderItemId: it.orderItemId ?? null, materialId, quantityMilli: it.quantityMilli, unit }));
    described.push(`${qtyLabel(ledger, it.quantityMilli, unit)} ${name}`);
  }
  const what = described.join(" y ");
  const ref = input.reference?.trim();
  ws.audit({
    action: "delivery.created",
    entityType: "delivery",
    entityId: deliveryId,
    summary: `${order ? `Pedido ${ledger.orderNumber(order)}` : ledger.supplierName(supplierId)} · ${what}${ref ? ` · Remito ${ref}` : ""}`,
    shortSummary: `${order ? `Pedido ${ledger.orderNumber(order)} · ` : ""}${what}`,
    supplierId,
    orderId: order?.id ?? null,
  });
  linkDocuments(ws, ctx, ledger, input.documentIds, { deliveryId }, { kind: "delivery_proof", supplierId, date: input.date, label: ledger.supplierName(supplierId), orderId: order?.id });
  await ws.commit();
  return { deliveryId, orderId: order?.id ?? null };
}

// ------------------------------------------------------------------ payments

export interface AllocationInput {
  orderId: string;
  amountMinor: number;
}

function checkAllocations(ledger: Ledger, supplierId: string, allocations: AllocationInput[], available: number) {
  const seen = new Set<string>();
  let total = 0;
  for (const a of allocations) {
    const order = ledger.order(a.orderId);
    assert(order, "order_unresolved", "Uno de los pedidos de la imputación no existe.");
    assert(order.supplierId === supplierId, "validation", `El pedido ${ledger.orderNumber(order)} es de otro proveedor.`);
    assert(!seen.has(order.id), "validation", `El pedido ${ledger.orderNumber(order)} aparece dos veces en la imputación.`);
    seen.add(order.id);
    assert(Number.isSafeInteger(a.amountMinor) && a.amountMinor > 0, "invalid_amount", "Cada imputación debe tener un importe mayor que cero.");
    const pending = ledger.orderPending(order);
    if (pending !== null && a.amountMinor > pending) {
      throw new DomainError(
        "allocation_exceeds_order",
        pending === 0
          ? `El pedido ${ledger.orderNumber(order)} ya está pagado. Imputa el pago a la cuenta corriente o a otro pedido.`
          : `Se imputan ${formatMoney(a.amountMinor)} al pedido ${ledger.orderNumber(order)} pero su saldo es ${formatMoney(pending)}. Deja el excedente sin imputar.`,
      );
    }
    total += a.amountMinor;
  }
  assert(total <= available, "allocation_exceeds_payment", `Las imputaciones (${formatMoney(total)}) superan el importe disponible del pago (${formatMoney(available)}).`);
}

function allocationTags(ledger: Ledger, orderId: string, extra: number): StatusTag[] {
  const order = ledger.order(orderId)!;
  const value = ledger.orderValue(order);
  const paid = ledger.orderPaid(orderId) + extra;
  const status = ledger.orderDeliveryStatus(order);
  return [status === "entregado" ? "entregado" : status === "parcial" ? "entrega_parcial" : "entrega_pendiente", value !== null && paid >= value ? "pagado" : "pago_parcial"];
}

export interface CreatePaymentInput {
  supplierId: string;
  date: string;
  amountMinor: number;
  method?: PaymentMethod | null;
  reference?: string | null;
  notes?: string | null;
  allocations: AllocationInput[];
  documentIds?: string[];
}

/** Records money paid to a supplier. It always lowers the supplier balance; allocations are optional. */
export async function createPayment(ctx: CommandContext, input: CreatePaymentInput): Promise<{ paymentId: string }> {
  const ledger = await snapshotFor(ctx);
  checkDate(input.date, "pago");
  assert(ledger.supplier(input.supplierId), "supplier_unresolved", "El proveedor del pago no existe.");
  assert(Number.isSafeInteger(input.amountMinor) && input.amountMinor > 0, "invalid_amount", "El importe del pago debe ser mayor que cero.");
  checkAllocations(ledger, input.supplierId, input.allocations, input.amountMinor);
  const ws = new WriteSet(ctx);
  const paymentId = newId();
  const supplierName = ledger.supplierName(input.supplierId);
  ws.add(
    ctx.db.insert(t.payments).values({
      id: paymentId,
      projectId: ctx.projectId,
      supplierId: input.supplierId,
      paymentDate: input.date,
      amountMinor: input.amountMinor,
      currency: ledger.s.project.currency,
      method: input.method ?? null,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      source: ctx.source,
      createdBy: ctx.actor.userId,
      createdAt: ws.stamp,
      updatedAt: ws.stamp,
    }),
  );
  const allocated = input.allocations.reduce((s, a) => s + a.amountMinor, 0);
  const method = input.method ? paymentMethodLabel[input.method] : "Sin medio indicado";
  ws.audit({
    action: "payment.created",
    entityType: "payment",
    entityId: paymentId,
    summary: `${formatMoney(input.amountMinor)} · ${supplierName} · ${method}`,
    shortSummary: `${formatMoney(input.amountMinor)} · ${supplierName}`,
    tags: allocated < input.amountMinor ? ["pago_sin_imputar"] : undefined,
    supplierId: input.supplierId,
    orderId: input.allocations.length === 1 ? input.allocations[0]!.orderId : null,
  });
  for (const a of input.allocations) {
    ws.add(ctx.db.insert(t.paymentAllocations).values({ id: newId(), paymentId, orderId: a.orderId, amountMinor: a.amountMinor, createdBy: ctx.actor.userId, createdAt: ws.stamp }));
    const number = ledger.orderNumber(ledger.order(a.orderId)!);
    ws.audit({
      action: "payment.allocated",
      entityType: "payment",
      entityId: paymentId,
      summary: `${formatMoney(a.amountMinor)} imputados al pedido ${number} · ${supplierName}`,
      shortSummary: `${formatMoney(a.amountMinor)} al pedido ${number}`,
      tags: allocationTags(ledger, a.orderId, a.amountMinor),
      supplierId: input.supplierId,
      orderId: a.orderId,
    });
  }
  linkDocuments(ws, ctx, ledger, input.documentIds, { paymentId }, {
    kind: "payment_proof",
    supplierId: input.supplierId,
    date: input.date,
    label: supplierName,
    orderId: input.allocations.length === 1 ? input.allocations[0]!.orderId : null,
  });
  await ws.commit();
  return { paymentId };
}

/** Applies (part of) an existing payment's unallocated amount to orders. The supplier balance does not change. */
export async function allocatePayment(ctx: CommandContext, paymentId: string, allocations: AllocationInput[]): Promise<{ allocationIds: string[] }> {
  const ledger = await snapshotFor(ctx);
  const payment = ledger.s.payments.find((p) => p.id === paymentId);
  assert(payment, "not_found", "El pago no existe o fue deshecho.");
  assert(allocations.length > 0, "validation", "Indica a qué pedido se imputa el pago.");
  checkAllocations(ledger, payment.supplierId, allocations, ledger.paymentUnallocated(payment));
  const ws = new WriteSet(ctx);
  const supplierName = ledger.supplierName(payment.supplierId);
  const allocationIds: string[] = [];
  for (const a of allocations) {
    const allocationId = newId();
    allocationIds.push(allocationId);
    ws.add(ctx.db.insert(t.paymentAllocations).values({ id: allocationId, paymentId, orderId: a.orderId, amountMinor: a.amountMinor, createdBy: ctx.actor.userId, createdAt: ws.stamp }));
    const number = ledger.orderNumber(ledger.order(a.orderId)!);
    ws.audit({
      action: "payment.allocated",
      entityType: "payment",
      entityId: paymentId,
      summary: `${formatMoney(a.amountMinor)} imputados al pedido ${number} · ${supplierName}`,
      shortSummary: `${formatMoney(a.amountMinor)} al pedido ${number}`,
      changes: [{ label: "Imputación", before: "Sin imputar", after: `Pedido ${number}` }],
      tags: allocationTags(ledger, a.orderId, a.amountMinor),
      supplierId: payment.supplierId,
      orderId: a.orderId,
    });
  }
  ws.add(ctx.db.update(t.payments).set({ updatedAt: ws.stamp }).where(eq(t.payments.id, paymentId)));
  await ws.commit();
  return { allocationIds };
}

// ------------------------------------------------------------------ voiding (undo)

export type VoidableType = "order" | "delivery" | "payment";

/**
 * Undo for a confirmed record: it is marked void (excluded from every
 * balance and status) and an audit entry records it. Nothing is deleted and
 * earlier audit entries are left untouched.
 */
export async function voidRecord(ctx: CommandContext, type: VoidableType, id: string, reason?: string): Promise<{ supplierId: string; orderId: string | null }> {
  const ledger = await snapshotFor(ctx);
  const ws = new WriteSet(ctx);
  const why = reason?.trim() || "Deshecho desde el asistente";
  if (type === "order") {
    const order = ledger.order(id);
    assert(order, "not_found", "El pedido ya no existe o ya fue deshecho.");
    assert(!ledger.deliveriesOf(order.id).length, "conflict", `El pedido ${ledger.orderNumber(order)} tiene entregas registradas. Deshaz primero las entregas.`);
    assert(ledger.orderPaid(order.id) === 0, "conflict", `El pedido ${ledger.orderNumber(order)} tiene pagos imputados. Deshaz primero los pagos.`);
    ws.add(ctx.db.update(t.orders).set({ voidedAt: ws.stamp, voidedBy: ctx.actor.userId, voidReason: why, updatedAt: ws.stamp }).where(eq(t.orders.id, id)));
    ws.audit({ action: "order.voided", entityType: "order", entityId: id, summary: `Pedido ${ledger.orderNumber(order)} · ${ledger.supplierName(order.supplierId)} · por ${ctx.actor.name}`, reason: why, supplierId: order.supplierId, orderId: id });
    await ws.commit();
    return { supplierId: order.supplierId, orderId: id };
  }
  if (type === "delivery") {
    const d = ledger.s.deliveries.find((x) => x.id === id);
    assert(d, "not_found", "La entrega ya no existe o ya fue deshecha.");
    ws.add(ctx.db.update(t.deliveries).set({ voidedAt: ws.stamp, voidedBy: ctx.actor.userId, voidReason: why, updatedAt: ws.stamp }).where(eq(t.deliveries.id, id)));
    const order = d.orderId ? ledger.order(d.orderId) : undefined;
    ws.audit({
      action: "delivery.voided",
      entityType: "delivery",
      entityId: id,
      summary: `${order ? `Pedido ${ledger.orderNumber(order)} · ` : ""}entrega del ${d.deliveryDate}${d.reference ? ` · remito ${d.reference}` : ""} · por ${ctx.actor.name}`,
      reason: why,
      supplierId: d.supplierId,
      orderId: d.orderId,
    });
    await ws.commit();
    return { supplierId: d.supplierId, orderId: d.orderId };
  }
  const p = ledger.s.payments.find((x) => x.id === id);
  assert(p, "not_found", "El pago ya no existe o ya fue deshecho.");
  ws.add(ctx.db.update(t.payments).set({ voidedAt: ws.stamp, voidedBy: ctx.actor.userId, voidReason: why, updatedAt: ws.stamp }).where(eq(t.payments.id, id)));
  ws.add(
    ctx.db
      .update(t.paymentAllocations)
      .set({ voidedAt: ws.stamp, voidedBy: ctx.actor.userId })
      .where(and(eq(t.paymentAllocations.paymentId, id), isNull(t.paymentAllocations.voidedAt))),
  );
  ws.audit({ action: "payment.voided", entityType: "payment", entityId: id, summary: `${formatMoney(p.amountMinor)} · ${ledger.supplierName(p.supplierId)} · por ${ctx.actor.name}`, reason: why, supplierId: p.supplierId });
  await ws.commit();
  return { supplierId: p.supplierId, orderId: null };
}

/** Undoes only the most recent allocation(s) of a payment made by an "imputar" confirmation. */
export async function voidAllocations(ctx: CommandContext, paymentId: string, allocationIds: string[]): Promise<void> {
  const ledger = await snapshotFor(ctx);
  const ws = new WriteSet(ctx);
  for (const allocationId of allocationIds) {
    const a = ledger.s.allocations.find((x) => x.id === allocationId && x.paymentId === paymentId);
    assert(a, "not_found", "La imputación ya no existe.");
    ws.add(ctx.db.update(t.paymentAllocations).set({ voidedAt: ws.stamp, voidedBy: ctx.actor.userId }).where(eq(t.paymentAllocations.id, allocationId)));
    const order = ledger.order(a.orderId)!;
    ws.audit({
      action: "payment.allocation_voided",
      entityType: "payment",
      entityId: paymentId,
      summary: `${formatMoney(a.amountMinor)} del pedido ${ledger.orderNumber(order)} vuelven a quedar sin imputar`,
      changes: [{ label: "Imputación", before: `Pedido ${ledger.orderNumber(order)}`, after: "Sin imputar" }],
      supplierId: order.supplierId,
      orderId: order.id,
    });
  }
  await ws.commit();
}

// ------------------------------------------------------------------ computation

export interface ComputationItemInput {
  /** Existing material, or a new catalog material created in the same batch. */
  material: MaterialRefInput;
  expectedQuantityMilli: number;
  unit?: string;
  stage?: string | null;
  wasteBasisPoints?: number;
  notes?: string | null;
}

/**
 * Adds or revises expected quantities. The current value is updated and every
 * change appends a revision row (previous → new), so the baseline history is
 * never lost. Historical orders need no migration: comparisons are derived.
 */
export async function setComputationItems(
  ctx: CommandContext,
  items: ComputationItemInput[],
  opts: { reason?: string | null; sourceDocumentId?: string | null; importLabel?: string } = {},
): Promise<{ version: number; created: number; revised: number }> {
  const ledger = await snapshotFor(ctx);
  assert(items.length > 0, "validation", "No hay cantidades de cómputo para guardar.");
  const ws = new WriteSet(ctx);
  let computation = ledger.s.computation;
  const version = (computation?.version ?? 0) + 1;
  if (!computation) {
    const id = newId();
    ws.add(
      ctx.db.insert(t.computations).values({ id, projectId: ctx.projectId, version, sourceDocumentId: opts.sourceDocumentId ?? null, createdBy: ctx.actor.userId, createdAt: ws.stamp, updatedAt: ws.stamp }),
    );
    computation = { id, projectId: ctx.projectId, version, sourceDocumentId: null, notes: null, createdBy: ctx.actor.userId, createdAt: ws.stamp, updatedAt: ws.stamp };
  } else {
    ws.add(ctx.db.update(t.computations).set({ version, updatedAt: ws.stamp, sourceDocumentId: opts.sourceDocumentId ?? computation.sourceDocumentId }).where(eq(t.computations.id, computation.id)));
  }
  const createdCatalog = new Map<string, string>();
  const changes: ActivityChange[] = [];
  let created = 0;
  let revised = 0;
  const seen = new Set<string>();
  for (const input of items) {
    const materialId = resolveMaterial(ws, ctx, ledger, input.material, "", createdCatalog);
    const material = ledger.material(materialId) ?? {
      id: materialId,
      name: "newName" in input.material ? input.material.newName.trim() : "Material",
      baseUnit: "newName" in input.material ? input.material.unit : "unidad",
    };
    assert(!seen.has(material.id), "validation", `${material.name} aparece dos veces en el cómputo.`);
    seen.add(material.id);
    checkQuantity(input.expectedQuantityMilli, material.name);
    const unit = input.unit ?? material.baseUnit;
    checkUnit(ledger, unit);
    const waste = input.wasteBasisPoints ?? 0;
    assert(Number.isSafeInteger(waste) && waste >= 0 && waste <= 10_000, "validation", `El desperdicio de ${material.name} no es válido.`);
    const current = ledger.computationItem(material.id);
    if (current && current.expectedQuantityMilli === input.expectedQuantityMilli && current.unit === unit && current.wasteBasisPoints === waste) continue;
    if (current) {
      revised++;
      ws.add(
        ctx.db
          .update(t.computationItems)
          .set({ expectedQuantityMilli: input.expectedQuantityMilli, unit, stage: input.stage ?? current.stage, wasteBasisPoints: waste, notes: input.notes ?? current.notes, reviewedOrderedMilli: null, updatedAt: ws.stamp })
          .where(eq(t.computationItems.id, current.id)),
      );
    } else {
      created++;
      ws.add(
        ctx.db.insert(t.computationItems).values({
          id: newId(),
          computationId: computation.id,
          materialId: material.id,
          expectedQuantityMilli: input.expectedQuantityMilli,
          unit,
          stage: input.stage ?? null,
          wasteBasisPoints: waste,
          notes: input.notes ?? null,
          updatedAt: ws.stamp,
        }),
      );
    }
    ws.add(
      ctx.db.insert(t.computationRevisions).values({
        id: newId(),
        computationId: computation.id,
        materialId: material.id,
        computationVersion: version,
        changeType: current ? "updated" : "created",
        previousQuantityMilli: current?.expectedQuantityMilli ?? null,
        newQuantityMilli: input.expectedQuantityMilli,
        previousUnit: current?.unit ?? null,
        newUnit: unit,
        reason: opts.reason ?? null,
        source: ctx.source,
        actorUserId: ctx.actor.userId,
        createdAt: ws.stamp,
      }),
    );
    changes.push({ label: material.name, before: current ? qtyLabel(ledger, current.expectedQuantityMilli, current.unit) : "sin cómputo", after: qtyLabel(ledger, input.expectedQuantityMilli, unit) });
  }
  if (!changes.length) return { version: computation.version, created: 0, revised: 0 };
  const single = changes.length === 1 && !opts.importLabel;
  ws.audit({
    action: opts.importLabel ? "computation.imported" : created ? "computation.item_created" : "computation.item_revised",
    entityType: "computation",
    entityId: computation.id,
    summary: single
      ? `${changes[0]!.label} · ${created ? "cantidad prevista definida" : "ajuste manual"} · por ${ctx.actor.name}`
      : `Cómputo v${version} · ${changes.length} materiales${opts.importLabel ? ` · ${opts.importLabel}` : ""} · por ${ctx.actor.name}`,
    changes: changes.slice(0, 12),
    reason: opts.reason ?? undefined,
  });
  await ws.commit();
  return { version, created, revised };
}

/** Silences the near/over-computation alert until more of the material is ordered. */
export async function markComputationReviewed(ctx: CommandContext, materialId: string): Promise<void> {
  const ledger = await snapshotFor(ctx);
  const item = ledger.computationItem(materialId);
  assert(item, "not_found", "Este material no tiene cómputo para revisar.");
  const ordered = ledger.materialTotals(materialId).orderedMilli;
  const ws = new WriteSet(ctx);
  ws.add(ctx.db.update(t.computationItems).set({ reviewedOrderedMilli: ordered }).where(eq(t.computationItems.id, item.id)));
  ws.audit({
    action: "computation.reviewed",
    entityType: "computation",
    entityId: item.computationId,
    summary: `${ledger.material(materialId)!.name} · revisado con ${qtyLabel(ledger, ordered, ledger.material(materialId)!.baseUnit)} pedidas · por ${ctx.actor.name}`,
  });
  await ws.commit();
}
