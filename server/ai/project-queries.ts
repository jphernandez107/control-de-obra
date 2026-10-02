import { z } from "zod";
import type { MatchOption } from "../../src/domain/assistant";
import type { Ledger } from "../domain/derive";
import { fromMilli } from "../domain/quantity";
import { materialSummary, orderDeliverySummary, orderFinancialSummary, supplierAccountSummary, type MaterialQuantitySummary } from "../domain/summaries";
import type { Order } from "../repositories/snapshot";
import { resolveMaterial, resolveOrderReference, resolveSupplier } from "./resolve";
import type { ProjectQueryName } from "./schemas";

// Safe, read-only query layer for the assistant. There is no SQL surface:
// each operation is a narrow, named function over the Ledger that returns
// structured data. The assistant runs them after a question is classified,
// and a future tool-calling provider can invoke them through
// `projectQueryTools()`. Money is integer minor units (centavos, ARS);
// quantities are decimals in the unit given next to them.

const optionalName = z.string().max(120).nullable().optional();

export const PROJECT_QUERY_ARGS = {
  get_supplier_summary: z.object({ supplier: z.string().min(1).max(120) }),
  list_supplier_balances: z.object({}),
  get_order_summary: z.object({ order: z.string().min(1).max(60), supplier: optionalName }),
  list_orders_pending_delivery: z.object({ supplier: optionalName }),
  list_delivered_unpaid_orders: z.object({ supplier: optionalName }),
  get_material_summary: z.object({ material: z.string().min(1).max(120) }),
  get_computation_variance: z.object({}),
  list_unallocated_payments: z.object({ supplier: optionalName }),
} satisfies Record<ProjectQueryName, z.ZodObject>;

export const PROJECT_QUERY_DESCRIPTIONS: Record<ProjectQueryName, string> = {
  get_supplier_summary: "Cuenta corriente de un proveedor: total conocido de pedidos, pagos, saldo, pagos sin imputar y pedidos sin importe.",
  list_supplier_balances: "Saldo con cada proveedor y saldo total.",
  get_order_summary: "Estado de un pedido: cantidades pedidas, entregadas y pendientes por material; importe conocido, pagado y saldo.",
  list_orders_pending_delivery: "Pedidos con material pendiente de entrega.",
  list_delivered_unpaid_orders: "Pedidos entregados completos que no están pagados.",
  get_material_summary: "Cantidad pedida y entregada de un material, comparada con el cómputo.",
  get_computation_variance: "Comparación de lo pedido contra el cómputo, material por material.",
  list_unallocated_payments: "Pagos a proveedores que todavía no están imputados a un pedido.",
};

export type ProjectQueryArgs<N extends ProjectQueryName> = z.infer<(typeof PROJECT_QUERY_ARGS)[N]>;

/** Ids already resolved by the application (e.g. from the conversation focus), which skip name matching. */
export interface ResolvedRefs {
  supplierId?: string;
  orderId?: string;
  materialId?: string;
}

// ------------------------------------------------------------------ result data

export interface OrderRef {
  orderId: string;
  number: string;
  supplierId: string;
  supplier: string;
  date: string;
}

export interface OrderBalanceRow extends OrderRef {
  knownTotalMinor: number | null;
  allocatedPaidMinor: number;
  remainingBalanceMinor: number | null;
  paymentStatus: "sin_pagos" | "parcial" | "pagado";
}

export interface SupplierSummaryData {
  supplierId: string;
  supplier: string;
  currency: "ARS";
  knownOrderTotalMinor: number;
  totalPaidMinor: number;
  allocatedPaidMinor: number;
  unallocatedPaidMinor: number;
  outstandingBalanceMinor: number;
  unknownValueOrders: OrderRef[];
  ordersWithBalance: OrderBalanceRow[];
  unallocatedPayments: UnallocatedPaymentRow[];
}

export interface SupplierBalancesData {
  currency: "ARS";
  totalOutstandingMinor: number;
  suppliers: { supplierId: string; supplier: string; outstandingBalanceMinor: number; unallocatedPaidMinor: number; unknownValueOrders: number }[];
}

export interface DeliveryLineData {
  material: string;
  unit: string;
  ordered: number;
  delivered: number;
  remaining: number;
}

export interface OrderSummaryData extends OrderRef {
  currency: "ARS";
  delivery: { status: "pendiente" | "parcial" | "entregado"; lines: DeliveryLineData[] };
  financial: { knownTotalMinor: number | null; allocatedPaidMinor: number; remainingBalanceMinor: number | null; status: "sin_pagos" | "parcial" | "pagado" };
}

export interface PendingDeliveryData {
  orders: (OrderRef & { status: "pendiente" | "parcial"; lines: DeliveryLineData[] })[];
}

export interface DeliveredUnpaidData {
  currency: "ARS";
  orders: OrderBalanceRow[];
}

export interface MaterialSummaryData {
  materialId: string;
  material: string;
  unit: string;
  ordered: number;
  delivered: number;
  pendingDelivery: number;
  expected: number | null;
  remainingExpected: number | null;
  /** ordered − expected; positive means over the computation. */
  variance: number | null;
  percentOrdered: number | null;
  status: MaterialQuantitySummary["status"];
}

export interface ComputationVarianceData {
  loaded: boolean;
  version: number | null;
  updatedAt: string | null;
  materials: MaterialSummaryData[];
}

export interface UnallocatedPaymentRow {
  paymentId: string;
  supplierId: string;
  supplier: string;
  date: string;
  amountMinor: number;
  unallocatedMinor: number;
  method: string | null;
}

export interface UnallocatedPaymentsData {
  currency: "ARS";
  totalMinor: number;
  payments: UnallocatedPaymentRow[];
}

interface DataByQuery {
  get_supplier_summary: SupplierSummaryData;
  list_supplier_balances: SupplierBalancesData;
  get_order_summary: OrderSummaryData;
  list_orders_pending_delivery: PendingDeliveryData;
  list_delivered_unpaid_orders: DeliveredUnpaidData;
  get_material_summary: MaterialSummaryData;
  get_computation_variance: ComputationVarianceData;
  list_unallocated_payments: UnallocatedPaymentsData;
}

export type ProjectQueryOk = { [N in ProjectQueryName]: { query: N; status: "ok"; data: DataByQuery[N] } }[ProjectQueryName];

export interface ProjectQueryUnresolved {
  query: ProjectQueryName;
  status: "not_found" | "ambiguous" | "missing_argument" | "invalid_arguments";
  argument?: "supplier" | "order" | "material";
  mention?: string | null;
  candidates: MatchOption[];
}

export type ProjectQueryResult = ProjectQueryOk | ProjectQueryUnresolved;

// ------------------------------------------------------------------ builders

function orderRef(ledger: Ledger, o: Order): OrderRef {
  return { orderId: o.id, number: ledger.orderNumber(o), supplierId: o.supplierId, supplier: ledger.supplierName(o.supplierId), date: o.orderDate };
}

function balanceRow(ledger: Ledger, o: Order): OrderBalanceRow {
  const f = orderFinancialSummary(ledger, o);
  return { ...orderRef(ledger, o), knownTotalMinor: f.knownTotalMinor, allocatedPaidMinor: f.allocatedPaidMinor, remainingBalanceMinor: f.remainingBalanceMinor, paymentStatus: f.status };
}

function deliveryLines(ledger: Ledger, o: Order, onlyPending: boolean): DeliveryLineData[] {
  return orderDeliverySummary(ledger, o)
    .lines.filter((l) => !onlyPending || l.remainingMilli > 0)
    .map((l) => ({ material: l.material, unit: l.unit, ordered: fromMilli(l.orderedMilli), delivered: fromMilli(l.deliveredMilli), remaining: fromMilli(l.remainingMilli) }));
}

function unallocatedRows(ledger: Ledger, supplierId?: string): UnallocatedPaymentRow[] {
  return ledger.s.payments
    .filter((p) => (!supplierId || p.supplierId === supplierId) && ledger.paymentUnallocated(p) > 0)
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate))
    .map((p) => ({ paymentId: p.id, supplierId: p.supplierId, supplier: ledger.supplierName(p.supplierId), date: p.paymentDate, amountMinor: p.amountMinor, unallocatedMinor: ledger.paymentUnallocated(p), method: p.method }));
}

export function materialData(ledger: Ledger, materialId: string): MaterialSummaryData {
  const s = materialSummary(ledger, ledger.material(materialId)!);
  const dec = (v: number | null) => (v === null ? null : fromMilli(v));
  return {
    materialId: s.materialId,
    material: s.material,
    unit: s.unit,
    ordered: fromMilli(s.orderedMilli),
    delivered: fromMilli(s.deliveredMilli),
    pendingDelivery: fromMilli(s.pendingDeliveryMilli),
    expected: dec(s.expectedMilli),
    remainingExpected: dec(s.remainingExpectedMilli),
    variance: dec(s.varianceMilli),
    percentOrdered: s.percentOrdered,
    status: s.status,
  };
}

function supplierData(ledger: Ledger, supplierId: string): SupplierSummaryData {
  const s = supplierAccountSummary(ledger, ledger.supplier(supplierId)!);
  const orders = ledger.s.orders.filter((o) => o.supplierId === supplierId).sort((a, b) => a.orderDate.localeCompare(b.orderDate));
  return {
    supplierId,
    supplier: s.supplierName,
    currency: "ARS",
    knownOrderTotalMinor: s.knownOrderTotalMinor,
    totalPaidMinor: s.totalPaidMinor,
    allocatedPaidMinor: s.allocatedPaidMinor,
    unallocatedPaidMinor: s.unallocatedPaidMinor,
    outstandingBalanceMinor: s.outstandingBalanceMinor,
    unknownValueOrders: orders.filter((o) => s.unknownValueOrderIds.includes(o.id)).map((o) => orderRef(ledger, o)),
    ordersWithBalance: orders.map((o) => balanceRow(ledger, o)).filter((r) => (r.remainingBalanceMinor ?? 0) > 0),
    unallocatedPayments: unallocatedRows(ledger, supplierId),
  };
}

function unresolved(query: ProjectQueryName, argument: ProjectQueryUnresolved["argument"], mention: string | null | undefined, r: { status: "not_found" | "ambiguous"; candidates: MatchOption[] }): ProjectQueryUnresolved {
  return { query, status: r.status, argument, mention: mention ?? null, candidates: r.candidates };
}

/** Optional supplier filter: a name that does not resolve is reported instead of ignored. */
function supplierFilter(ledger: Ledger, query: ProjectQueryName, mention: string | null | undefined, refs: ResolvedRefs): { id?: string; error?: ProjectQueryUnresolved } {
  if (refs.supplierId) return { id: refs.supplierId };
  if (!mention) return {};
  const r = resolveSupplier(ledger, mention);
  return r.status === "ok" ? { id: r.value } : { error: unresolved(query, "supplier", mention, r) };
}

/**
 * Runs one named read-only query. Arguments are validated; names are
 * resolved with the deterministic matchers. Nothing is written.
 */
export function runProjectQuery(ledger: Ledger, query: ProjectQueryName, rawArgs: unknown, refs: ResolvedRefs = {}): ProjectQueryResult {
  const schema = PROJECT_QUERY_ARGS[query];
  // Arguments already resolved to ids may stand in for required names.
  const given = Object.fromEntries(Object.entries((rawArgs ?? {}) as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  const parsed = schema.safeParse({ ...(refs.supplierId ? { supplier: "-" } : {}), ...(refs.orderId ? { order: "-" } : {}), ...(refs.materialId ? { material: "-" } : {}), ...given });
  if (!parsed.success) {
    const missing = parsed.error.issues[0]?.path[0];
    return { query, status: missing ? "missing_argument" : "invalid_arguments", argument: missing === "supplier" || missing === "order" || missing === "material" ? missing : undefined, candidates: [] };
  }
  const args = parsed.data as Record<string, string | null | undefined>;

  switch (query) {
    case "get_supplier_summary": {
      const f = supplierFilter(ledger, query, args.supplier, refs);
      if (f.error) return f.error;
      return { query, status: "ok", data: supplierData(ledger, f.id!) };
    }
    case "list_supplier_balances": {
      const suppliers = ledger.s.suppliers.map((s) => supplierAccountSummary(ledger, s));
      return {
        query,
        status: "ok",
        data: {
          currency: "ARS",
          totalOutstandingMinor: suppliers.reduce((s, x) => s + x.outstandingBalanceMinor, 0),
          suppliers: suppliers
            .map((s) => ({ supplierId: s.supplierId, supplier: s.supplierName, outstandingBalanceMinor: s.outstandingBalanceMinor, unallocatedPaidMinor: s.unallocatedPaidMinor, unknownValueOrders: s.unknownValueOrderIds.length }))
            .sort((a, b) => b.outstandingBalanceMinor - a.outstandingBalanceMinor),
        },
      };
    }
    case "get_order_summary": {
      let order = refs.orderId ? ledger.order(refs.orderId) : undefined;
      if (!order) {
        const f = supplierFilter(ledger, query, args.supplier, refs);
        if (f.error) return f.error;
        const r = resolveOrderReference(ledger, args.order!, f.id);
        if (r.status !== "ok") return unresolved(query, "order", args.order, r);
        order = r.value;
      }
      const fin = orderFinancialSummary(ledger, order);
      return {
        query,
        status: "ok",
        data: {
          ...orderRef(ledger, order),
          currency: "ARS",
          delivery: { status: ledger.orderDeliveryStatus(order), lines: deliveryLines(ledger, order, false) },
          financial: { knownTotalMinor: fin.knownTotalMinor, allocatedPaidMinor: fin.allocatedPaidMinor, remainingBalanceMinor: fin.remainingBalanceMinor, status: fin.status },
        },
      };
    }
    case "list_orders_pending_delivery": {
      const f = supplierFilter(ledger, query, args.supplier, refs);
      if (f.error) return f.error;
      const orders = ledger.s.orders
        .filter((o) => (!f.id || o.supplierId === f.id) && ledger.orderDeliveryStatus(o) !== "entregado")
        .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
      return { query, status: "ok", data: { orders: orders.map((o) => ({ ...orderRef(ledger, o), status: ledger.orderDeliveryStatus(o) as "pendiente" | "parcial", lines: deliveryLines(ledger, o, true) })) } };
    }
    case "list_delivered_unpaid_orders": {
      const f = supplierFilter(ledger, query, args.supplier, refs);
      if (f.error) return f.error;
      const orders = ledger.s.orders
        .filter((o) => (!f.id || o.supplierId === f.id) && ledger.orderDeliveryStatus(o) === "entregado" && ledger.orderPaymentStatus(o) !== "pagado")
        .sort((a, b) => a.orderDate.localeCompare(b.orderDate));
      return { query, status: "ok", data: { currency: "ARS", orders: orders.map((o) => balanceRow(ledger, o)) } };
    }
    case "get_material_summary": {
      let materialId = refs.materialId;
      if (!materialId) {
        const r = resolveMaterial(ledger, args.material!);
        if (r.status !== "ok") return unresolved(query, "material", args.material, r);
        materialId = r.value;
      }
      return { query, status: "ok", data: materialData(ledger, materialId) };
    }
    case "get_computation_variance": {
      const info = ledger.computationInfo();
      const tracked = ledger.materialsOverview().materials.map((m) => materialData(ledger, m.id));
      return { query, status: "ok", data: { loaded: info.loaded, version: info.version ?? null, updatedAt: info.updatedAt ?? null, materials: tracked } };
    }
    case "list_unallocated_payments": {
      const f = supplierFilter(ledger, query, args.supplier, refs);
      if (f.error) return f.error;
      const payments = unallocatedRows(ledger, f.id);
      return { query, status: "ok", data: { currency: "ARS", totalMinor: payments.reduce((s, p) => s + p.unallocatedMinor, 0), payments } };
    }
  }
}

/** Tool definitions (name, description, JSON Schema parameters) for providers that support tool calling. */
export function projectQueryTools(): { name: ProjectQueryName; description: string; parameters: Record<string, unknown> }[] {
  return (Object.keys(PROJECT_QUERY_ARGS) as ProjectQueryName[]).map((name) => ({
    name,
    description: PROJECT_QUERY_DESCRIPTIONS[name],
    parameters: z.toJSONSchema(PROJECT_QUERY_ARGS[name]) as Record<string, unknown>,
  }));
}
