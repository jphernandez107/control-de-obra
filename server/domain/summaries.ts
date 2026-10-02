import type { Ledger } from "./derive";
import type { Material, Order, Supplier } from "../repositories/snapshot";

// Deterministic calculations the AI is never trusted with. Every figure is
// derived from persisted records through the Ledger: money in integer minor
// units, quantities in integer thousandths. Proposals, confirmation checks
// and the read-only query layer all use these functions, and they work
// without any AI provider.

export interface OrderDeliveryLine {
  orderItemId: string;
  materialId: string;
  material: string;
  unit: string;
  orderedMilli: number;
  deliveredMilli: number;
  remainingMilli: number;
}

export interface OrderDeliverySummary {
  orderId: string;
  status: "pendiente" | "parcial" | "entregado";
  lines: OrderDeliveryLine[];
}

/** ordered / delivered / remaining per order line. */
export function orderDeliverySummary(ledger: Ledger, order: Order): OrderDeliverySummary {
  return {
    orderId: order.id,
    status: ledger.orderDeliveryStatus(order),
    lines: ledger.items(order.id).map((i) => {
      const delivered = Math.min(ledger.deliveredMilli(i.id), i.quantityMilli);
      return {
        orderItemId: i.id,
        materialId: i.materialId,
        material: ledger.material(i.materialId)?.name ?? i.description,
        unit: ledger.unitLabel(i.unit),
        orderedMilli: i.quantityMilli,
        deliveredMilli: delivered,
        remainingMilli: ledger.remainingMilli(i),
      };
    }),
  };
}

export interface OrderFinancialSummary {
  orderId: string;
  /** Stated total, or the sum of line totals when every line is priced; null when unknown. */
  knownTotalMinor: number | null;
  /** Only payments allocated to this order. Unallocated supplier payments never make an order look paid. */
  allocatedPaidMinor: number;
  /** null when the order value is unknown: never invented. */
  remainingBalanceMinor: number | null;
  status: "sin_pagos" | "parcial" | "pagado";
}

export function orderFinancialSummary(ledger: Ledger, order: Order): OrderFinancialSummary {
  return {
    orderId: order.id,
    knownTotalMinor: ledger.orderValue(order),
    allocatedPaidMinor: ledger.orderPaid(order.id),
    remainingBalanceMinor: ledger.orderPending(order),
    status: ledger.orderPaymentStatus(order),
  };
}

export interface SupplierAccountSummary {
  supplierId: string;
  supplierName: string;
  /** Σ known order values. */
  knownOrderTotalMinor: number;
  /** Orders whose value is unknown; they are not part of the total. */
  unknownValueOrderIds: string[];
  /** Σ every payment to the supplier, allocated or not. */
  totalPaidMinor: number;
  allocatedPaidMinor: number;
  unallocatedPaidMinor: number;
  /** known order totals − all payments. */
  outstandingBalanceMinor: number;
}

export function supplierAccountSummary(ledger: Ledger, supplier: Supplier): SupplierAccountSummary {
  const orders = ledger.s.orders.filter((o) => o.supplierId === supplier.id);
  const payments = ledger.s.payments.filter((p) => p.supplierId === supplier.id);
  let known = 0;
  const unknown: string[] = [];
  for (const o of orders) {
    const v = ledger.orderValue(o);
    if (v === null) unknown.push(o.id);
    else known += v;
  }
  const totalPaid = payments.reduce((s, p) => s + p.amountMinor, 0);
  const allocated = payments.reduce((s, p) => s + ledger.paymentAllocated(p.id), 0);
  return {
    supplierId: supplier.id,
    supplierName: supplier.name,
    knownOrderTotalMinor: known,
    unknownValueOrderIds: unknown,
    totalPaidMinor: totalPaid,
    allocatedPaidMinor: allocated,
    unallocatedPaidMinor: totalPaid - allocated,
    outstandingBalanceMinor: known - totalPaid,
  };
}

export interface MaterialQuantitySummary {
  materialId: string;
  material: string;
  unit: string;
  orderedMilli: number;
  deliveredMilli: number;
  pendingDeliveryMilli: number;
  /** Computation quantity including waste, in the material's base unit; null without computation. */
  expectedMilli: number | null;
  /** expected − ordered, floored at 0; null without computation. */
  remainingExpectedMilli: number | null;
  /** ordered − expected (positive = over the computation); null without computation. */
  varianceMilli: number | null;
  /** ordered / expected × 100, rounded; null without computation. */
  percentOrdered: number | null;
  status: "supera" | "alcanzado" | "cerca" | "dentro" | "sin_computo";
  /** Lines in a unit without a conversion to the base unit (not counted). */
  unconvertedLines: number;
}

export function materialSummary(ledger: Ledger, material: Material): MaterialQuantitySummary {
  const t = ledger.materialTotals(material.id);
  const expected = ledger.expectedMilli(material.id);
  const computation = ledger.computationFor(material.id, t.orderedMilli);
  const hasComputation = expected !== null && expected > 0;
  return {
    materialId: material.id,
    material: material.name,
    unit: ledger.unitLabel(material.baseUnit),
    orderedMilli: t.orderedMilli,
    deliveredMilli: t.deliveredMilli,
    pendingDeliveryMilli: Math.max(t.orderedMilli - t.deliveredMilli, 0),
    expectedMilli: hasComputation ? expected : null,
    remainingExpectedMilli: hasComputation ? Math.max(expected - t.orderedMilli, 0) : null,
    varianceMilli: hasComputation ? t.orderedMilli - expected : null,
    percentOrdered: computation?.percent ?? null,
    status: computation?.status ?? "sin_computo",
    unconvertedLines: t.unconverted,
  };
}

// ------------------------------------------------------------------ material facts

/** A quantity in thousandths of a unit code. */
export interface Qty {
  milli: number;
  unit: string;
}

export interface MaterialLineFact {
  orderItemId: string;
  orderId: string;
  orderNumber: string;
  supplierId: string;
  supplier: string;
  date: string;
  /** Purchase quantity and unit (172 barras). */
  quantityMilli: number;
  unit: string;
  /** Size of one purchase unit (12 m), from the document or the catalog. */
  unitSize: Qty | null;
  /** Derived: quantity × size (2.064 m). */
  equivalent: Qty | null;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  deliveredMilli: number;
  remainingMilli: number;
}

export interface MaterialFacts {
  materialId: string;
  material: string;
  shortName: string;
  baseUnit: string;
  lines: MaterialLineFact[];
  /** Grouped by unit: lines are converted to the base unit when possible; others keep their own unit. Never summed across units. */
  ordered: Qty[];
  delivered: Qty[];
  pendingDelivery: Qty[];
  /** Equivalent of everything ordered, only when every line has one in the same unit. */
  equivalent: Qty | null;
  /** Purchase unit size shared by every line (each bar is 12 m). */
  unitSize: Qty | null;
  /** Σ line totals of priced lines (ARS minor units). */
  amount: { knownMinor: number; pricedLines: number; unpricedLines: number };
  deliveries: { deliveryId: string; date: string; reference: string | null; milli: number; unit: string; orderNumber: string | null }[];
  /** Computation in the base unit, waste included. Compared with everything ordered (all orders). */
  computation: { expectedMilli: number; wasteBasisPoints: number; orderedMilli: number; remainingToOrderMilli: number; overMilli: number; percent: number } | null;
}

export interface MaterialFilter {
  supplierId?: string;
  orderId?: string;
}

function addTo(groups: Qty[], milli: number, unit: string) {
  const g = groups.find((x) => x.unit === unit);
  if (g) g.milli += milli;
  else groups.push({ milli, unit });
}

/**
 * Everything persisted about one material, from structured records only
 * (order lines, deliveries, computation) — never from documents. Each line
 * keeps its own purchase unit; totals are grouped by unit so bars and
 * kilograms are never added together.
 */
export function materialFacts(ledger: Ledger, materialId: string, filter: MaterialFilter = {}): MaterialFacts {
  const material = ledger.material(materialId)!;
  const base = material.baseUnit;
  const items = ledger.s.orderItems
    .filter((i) => i.materialId === materialId)
    .map((i) => ({ i, o: ledger.order(i.orderId) }))
    .filter((x): x is { i: (typeof x)["i"]; o: Order } => Boolean(x.o) && (!filter.orderId || x.o!.id === filter.orderId) && (!filter.supplierId || x.o!.supplierId === filter.supplierId))
    .sort((a, b) => a.o.orderDate.localeCompare(b.o.orderDate) || a.o.internalNumber - b.o.internalNumber);
  const ordered: Qty[] = [];
  const delivered: Qty[] = [];
  const pendingDelivery: Qty[] = [];
  const add = (groups: Qty[], item: (typeof items)[number]["i"], milli: number) => {
    const inBase = ledger.lineQuantityIn(item, milli, base);
    if (inBase === null) addTo(groups, milli, item.unit);
    else addTo(groups, inBase, base);
  };
  const lines: MaterialLineFact[] = items.map(({ i, o }) => {
    const deliveredMilli = Math.min(ledger.deliveredMilli(i.id), i.quantityMilli);
    const remainingMilli = ledger.remainingMilli(i);
    add(ordered, i, i.quantityMilli);
    add(delivered, i, deliveredMilli);
    add(pendingDelivery, i, remainingMilli);
    const size = ledger.unitSizeOf(i);
    return {
      orderItemId: i.id,
      orderId: o.id,
      orderNumber: ledger.orderNumber(o),
      supplierId: o.supplierId,
      supplier: ledger.supplierName(o.supplierId),
      date: o.orderDate,
      quantityMilli: i.quantityMilli,
      unit: i.unit,
      unitSize: size,
      equivalent: ledger.equivalentOf(i),
      unitPriceMinor: i.unitPriceMinor,
      lineTotalMinor: i.lineTotalMinor,
      deliveredMilli,
      remainingMilli,
    };
  });
  const lineIds = new Set(lines.map((l) => l.orderItemId));
  const deliveries = ledger.s.deliveryItems
    .filter((di) => di.materialId === materialId && (di.orderItemId ? lineIds.has(di.orderItemId) : !filter.orderId && !filter.supplierId))
    .map((di) => {
      const d = ledger.s.deliveries.find((x) => x.id === di.deliveryId)!;
      const order = d.orderId ? ledger.order(d.orderId) : undefined;
      return { deliveryId: d.id, date: d.deliveryDate, reference: d.reference, milli: di.quantityMilli, unit: di.unit, orderNumber: order ? ledger.orderNumber(order) : null };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  // Deliveries recorded without an order line still count as delivered.
  for (const di of ledger.s.deliveryItems) {
    if (di.materialId !== materialId || di.orderItemId || filter.orderId || filter.supplierId) continue;
    const inBase = ledger.convertForMaterial(materialId, di.quantityMilli, di.unit, base);
    addTo(delivered, inBase ?? di.quantityMilli, inBase === null ? di.unit : base);
  }
  const equivalents = lines.map((l) => l.equivalent);
  const equivalent = equivalents.length && equivalents.every((e) => e && e.unit === equivalents[0]!.unit) ? { milli: equivalents.reduce((s, e) => s + e!.milli, 0), unit: equivalents[0]!.unit } : null;
  const sizes = lines.map((l) => l.unitSize);
  const unitSize = sizes.length && sizes.every((x) => x && x.unit === sizes[0]!.unit && x.milli === sizes[0]!.milli) && lines.every((l) => l.unit === lines[0]!.unit) ? sizes[0]! : null;
  const priced = lines.filter((l) => l.lineTotalMinor !== null);
  const expected = ledger.expectedMilli(materialId);
  const totalOrdered = ledger.materialTotals(materialId).orderedMilli;
  const c = ledger.computationItem(materialId);
  return {
    materialId,
    material: material.name,
    shortName: material.shortName,
    baseUnit: base,
    lines,
    ordered,
    delivered: delivered.length ? delivered : [{ milli: 0, unit: base }],
    pendingDelivery,
    equivalent,
    unitSize,
    amount: { knownMinor: priced.reduce((s, l) => s + l.lineTotalMinor!, 0), pricedLines: priced.length, unpricedLines: lines.length - priced.length },
    deliveries,
    computation:
      expected !== null && expected > 0 && c
        ? {
            expectedMilli: expected,
            wasteBasisPoints: c.wasteBasisPoints,
            orderedMilli: totalOrdered,
            remainingToOrderMilli: Math.max(expected - totalOrdered, 0),
            overMilli: Math.max(totalOrdered - expected, 0),
            percent: Math.round((totalOrdered * 100) / expected),
          }
        : null,
  };
}
