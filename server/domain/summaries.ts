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
