import { z } from "zod";
import type { MatchOption } from "../../src/domain/assistant";
import type { Ledger } from "../domain/derive";
import { fromMilli } from "../domain/quantity";
import { matchMaterial } from "../domain/matching";
import { materialFacts, materialSummary, orderDeliverySummary, orderFinancialSummary, supplierAccountSummary, type MaterialFacts, type MaterialFilter, type MaterialQuantitySummary, type Qty } from "../domain/summaries";
import type { Order, OrderItem } from "../repositories/snapshot";
import { materialCandidates, resolveMaterial, resolveOrderReference, resolveSupplier } from "./resolve";
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
  search_materials: z.object({ query: z.string().min(1).max(120) }),
  get_material_order_summary: z.object({ material: z.string().min(1).max(120), supplier: optionalName, order: z.string().max(60).nullable().optional() }),
  get_material_delivery_summary: z.object({ material: z.string().min(1).max(120), supplier: optionalName, order: z.string().max(60).nullable().optional() }),
  get_material_history: z.object({ material: z.string().min(1).max(120) }),
  get_order_items: z.object({ order: z.string().min(1).max(60), supplier: optionalName }),
  search_order_items: z.object({ material: optionalName, supplier: optionalName, status: z.enum(["pendiente", "entregado", "todos"]).nullable().optional() }),
  get_computation_comparison: z.object({ material: z.string().min(1).max(120) }),
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
  search_materials: "Busca materiales del catálogo por cómo se los nombra («hierro del 12», «alambre»). Devuelve candidatos con su unidad.",
  get_material_order_summary:
    "Cuánto se pidió de un material: cantidad en su unidad de compra (barras, kg…), medida de cada unidad (12 m), equivalente (2.064 m), entregado, pendiente, importe y precio unitario por pedido. Opcional: proveedor o pedido.",
  get_material_delivery_summary: "Cuánto llegó y cuánto falta entregar de un material, con las entregas (fecha y remito).",
  get_material_history: "Historial de compras de un material: cada pedido con fecha, cantidad y precio.",
  get_order_items: "Líneas de un pedido: material, cantidad y unidad de compra, medida, precio unitario, importe, entregado y pendiente.",
  search_order_items: "Líneas de pedidos filtradas por material, proveedor y estado de entrega (pendiente, entregado, todos).",
  get_computation_comparison: "Cómputo de un material (cantidad prevista con desperdicio) comparado con lo pedido: cuánto falta pedir o cuánto se pasó.",
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

/** A quantity for the provider: number in `unit` (code) plus the Spanish text the app would show. */
export interface QtyData {
  quantity: number;
  unit: string;
  text: string;
}

export interface MaterialOrderLineData {
  orderId: string;
  number: string;
  supplier: string;
  date: string;
  quantity: QtyData;
  /** Size of one purchase unit (12 m per barra), when known. */
  unitSize: QtyData | null;
  equivalent: QtyData | null;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  delivered: QtyData;
  pending: QtyData;
}

/** Structured facts about one material, from persisted records only. Quantities in different units are listed apart, never summed. */
export interface MaterialFactsData {
  materialId: string;
  canonicalName: string;
  /** Material's own unit (the unit of the computation and of `ordered` when lines convert). */
  unit: string;
  ordered: QtyData[];
  equivalentQuantity: QtyData | null;
  unitSize: QtyData | null;
  delivered: QtyData[];
  pendingDelivery: QtyData[];
  currency: "ARS";
  /** Σ priced line totals; `unpricedLines` > 0 means the real amount is higher. */
  knownAmountMinor: number;
  unpricedLines: number;
  computation: { expected: QtyData; wastePercent: number; remainingToOrder: QtyData; overComputation: QtyData; percentOrdered: number } | null;
  orders: MaterialOrderLineData[];
  deliveries: { date: string; remito: string | null; quantity: QtyData; orderNumber: string | null }[];
}

export interface MaterialSearchData {
  query: string;
  candidates: { materialId: string; name: string; unit: string; score: number }[];
}

export interface OrderItemsData extends OrderRef {
  currency: "ARS";
  knownTotalMinor: number | null;
  items: (Omit<MaterialOrderLineData, "orderId" | "number" | "supplier" | "date"> & { orderItemId: string; materialId: string; material: string; description: string })[];
}

export interface OrderItemsSearchData {
  currency: "ARS";
  items: (MaterialOrderLineData & { orderItemId: string; materialId: string; material: string })[];
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
  search_materials: MaterialSearchData;
  get_material_order_summary: MaterialFactsData;
  get_material_delivery_summary: MaterialFactsData;
  get_material_history: MaterialFactsData;
  get_order_items: OrderItemsData;
  search_order_items: OrderItemsSearchData;
  get_computation_comparison: MaterialFactsData;
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

export function qtyData(ledger: Ledger, q: Qty): QtyData {
  return { quantity: fromMilli(q.milli), unit: q.unit, text: ledger.quantityText(q.milli, q.unit) };
}

function lineData(ledger: Ledger, item: OrderItem): Omit<MaterialOrderLineData, "orderId" | "number" | "supplier" | "date"> {
  const size = ledger.unitSizeOf(item);
  const eq = ledger.equivalentOf(item);
  const delivered = Math.min(ledger.deliveredMilli(item.id), item.quantityMilli);
  return {
    quantity: qtyData(ledger, { milli: item.quantityMilli, unit: item.unit }),
    unitSize: size ? qtyData(ledger, size) : null,
    equivalent: eq ? qtyData(ledger, eq) : null,
    unitPriceMinor: item.unitPriceMinor,
    lineTotalMinor: item.lineTotalMinor,
    delivered: qtyData(ledger, { milli: delivered, unit: item.unit }),
    pending: qtyData(ledger, { milli: ledger.remainingMilli(item), unit: item.unit }),
  };
}

export function materialFactsData(ledger: Ledger, f: MaterialFacts): MaterialFactsData {
  const q = (x: Qty) => qtyData(ledger, x);
  const c = f.computation;
  return {
    materialId: f.materialId,
    canonicalName: f.material,
    unit: f.baseUnit,
    ordered: f.ordered.map(q),
    equivalentQuantity: f.equivalent ? q(f.equivalent) : null,
    unitSize: f.unitSize ? q(f.unitSize) : null,
    delivered: f.delivered.map(q),
    pendingDelivery: f.pendingDelivery.map(q),
    currency: "ARS",
    knownAmountMinor: f.amount.knownMinor,
    unpricedLines: f.amount.unpricedLines,
    computation: c
      ? {
          expected: q({ milli: c.expectedMilli, unit: f.baseUnit }),
          wastePercent: c.wasteBasisPoints / 100,
          remainingToOrder: q({ milli: c.remainingToOrderMilli, unit: f.baseUnit }),
          overComputation: q({ milli: c.overMilli, unit: f.baseUnit }),
          percentOrdered: c.percent,
        }
      : null,
    orders: f.lines.map((l) => ({ orderId: l.orderId, number: l.orderNumber, supplier: l.supplier, date: l.date, ...lineData(ledger, ledger.orderItem(l.orderItemId)!) })),
    deliveries: f.deliveries.map((d) => ({ date: d.date, remito: d.reference, quantity: q({ milli: d.milli, unit: d.unit }), orderNumber: d.orderNumber })),
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
    case "search_materials": {
      const r = matchMaterial(args.query!, materialCandidates(ledger));
      return {
        query,
        status: "ok",
        data: { query: args.query!, candidates: r.candidates.map((c) => ({ materialId: c.item.id, name: c.item.name, unit: c.item.baseUnit, score: Math.round(c.score * 100) / 100 })) },
      };
    }
    case "get_material_order_summary":
    case "get_material_delivery_summary":
    case "get_material_history":
    case "get_computation_comparison": {
      const m = materialArg(ledger, query, args.material, refs);
      if (m.error) return m.error;
      const scope = materialScope(ledger, query, args, refs);
      if (scope.error) return scope.error;
      return { query, status: "ok", data: materialFactsData(ledger, materialFacts(ledger, m.id!, scope.filter)) } as ProjectQueryOk;
    }
    case "get_order_items": {
      let order = refs.orderId ? ledger.order(refs.orderId) : undefined;
      if (!order) {
        const f = supplierFilter(ledger, query, args.supplier, refs);
        if (f.error) return f.error;
        const r = resolveOrderReference(ledger, args.order!, f.id);
        if (r.status !== "ok") return unresolved(query, "order", args.order, r);
        order = r.value;
      }
      return {
        query,
        status: "ok",
        data: {
          ...orderRef(ledger, order),
          currency: "ARS",
          knownTotalMinor: ledger.orderValue(order),
          items: ledger.items(order.id).map((i) => ({ orderItemId: i.id, materialId: i.materialId, material: ledger.material(i.materialId)?.name ?? i.description, description: i.description, ...lineData(ledger, i) })),
        },
      };
    }
    case "search_order_items": {
      const f = supplierFilter(ledger, query, args.supplier, refs);
      if (f.error) return f.error;
      let materialId = refs.materialId;
      if (!materialId && args.material) {
        const r = resolveMaterial(ledger, args.material);
        if (r.status !== "ok") return unresolved(query, "material", args.material, r);
        materialId = r.value;
      }
      const status = args.status ?? "todos";
      const items = ledger.s.orderItems
        .filter((i) => (!materialId || i.materialId === materialId) && ledger.order(i.orderId) && (!f.id || ledger.order(i.orderId)!.supplierId === f.id))
        .filter((i) => status === "todos" || (status === "pendiente" ? ledger.remainingMilli(i) > 0 : ledger.remainingMilli(i) === 0))
        .map((i) => {
          const o = ledger.order(i.orderId)!;
          return { orderItemId: i.id, materialId: i.materialId, material: ledger.material(i.materialId)?.name ?? i.description, orderId: o.id, number: ledger.orderNumber(o), supplier: ledger.supplierName(o.supplierId), date: o.orderDate, ...lineData(ledger, i) };
        })
        .sort((a, b) => a.date.localeCompare(b.date));
      return { query, status: "ok", data: { currency: "ARS", items } };
    }
  }
}

function materialArg(ledger: Ledger, query: ProjectQueryName, mention: string | null | undefined, refs: ResolvedRefs): { id?: string; error?: ProjectQueryUnresolved } {
  if (refs.materialId) return { id: refs.materialId };
  const r = resolveMaterial(ledger, mention!);
  return r.status === "ok" ? { id: r.value } : { error: unresolved(query, "material", mention, r) };
}

/** Optional order/supplier restriction of a material query ("¿cuántas barras del 12 se pidieron en el pedido 1?"). */
function materialScope(ledger: Ledger, query: ProjectQueryName, args: Record<string, string | null | undefined>, refs: ResolvedRefs): { filter: MaterialFilter; error?: ProjectQueryUnresolved } {
  const f = args.supplier ? supplierFilter(ledger, query, args.supplier, {}) : {};
  if (f.error) return { filter: {}, error: f.error };
  if (args.order) {
    const r = resolveOrderReference(ledger, args.order, f.id);
    if (r.status !== "ok") return { filter: {}, error: unresolved(query, "order", args.order, r) };
    return { filter: { orderId: r.value.id } };
  }
  void refs;
  return { filter: f.id ? { supplierId: f.id } : {} };
}

/** Tool definitions (name, description, JSON Schema parameters) for providers that support tool calling. */
export function projectQueryTools(): { name: ProjectQueryName; description: string; parameters: Record<string, unknown> }[] {
  return (Object.keys(PROJECT_QUERY_ARGS) as ProjectQueryName[]).map((name) => ({
    name,
    description: PROJECT_QUERY_DESCRIPTIONS[name],
    parameters: z.toJSONSchema(PROJECT_QUERY_ARGS[name]) as Record<string, unknown>,
  }));
}
