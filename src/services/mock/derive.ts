import type {
  ActivityEvent,
  AttentionItem,
  DashboardSummary,
  DeliveryStatus,
  DocumentRef,
  LedgerEntry,
  MaterialComputation,
  MaterialDetail,
  MaterialSummary,
  MaterialsOverview,
  OrderDetail,
  OrderSummary,
  OrdersOverview,
  Payment,
  PaymentStatus,
  PendingDeliveryLine,
  SupplierDetail,
  SupplierSummary,
  SuppliersOverview,
} from "@/domain/types";
import { formatMoney, formatNumber, paymentMethodLabel } from "@/domain/format";
import type { Db, DbMaterial, DbOrder, DbOrderLine } from "./db";

// Mirrors the business rules in the design's "Reglas del sistema" board.
// The real backend will own these; the mock keeps them in one place.

export const NEAR_THRESHOLD = 85;

function material(db: Db, id: string): DbMaterial | undefined {
  return db.materials.find((m) => m.id === id);
}

function supplierName(db: Db, id: string): string {
  return db.suppliers.find((s) => s.id === id)?.name ?? "Proveedor";
}

function lineDelivered(db: Db, line: DbOrderLine): number {
  return db.deliveries.reduce(
    (sum, d) => sum + d.lines.filter((l) => l.orderLineId === line.id).reduce((s, l) => s + l.quantity, 0),
    0,
  );
}

function orderTotal(order: DbOrder): number | null {
  if (order.lines.some((l) => l.amount === null)) return null;
  return order.lines.reduce((s, l) => s + (l.amount ?? 0), 0);
}

function orderPaid(db: Db, order: DbOrder): number {
  return db.payments.filter((p) => p.orderId === order.id).reduce((s, p) => s + p.amount, 0);
}

export function deliveryStatusOf(ordered: number, delivered: number): DeliveryStatus {
  if (delivered <= 0) return "pendiente";
  if (delivered < ordered) return "parcial";
  return "entregado";
}

export function paymentStatusOf(total: number | null, paid: number): PaymentStatus {
  if (paid <= 0) return "sin_pagos";
  if (total !== null && paid >= total) return "pagado";
  return "parcial";
}

function remainingLabel(db: Db, order: DbOrder): string | undefined {
  const parts = order.lines
    .map((l) => ({ l, rest: l.quantity - lineDelivered(db, l) }))
    .filter(({ rest }) => rest > 0)
    .map(({ l, rest }) => {
      const m = material(db, l.materialId);
      return `${formatNumber(rest)} ${m?.unit ?? "u"} ${m?.shortName ?? l.description}`;
    });
  return parts.length ? `Faltan ${parts.join(" y ")}` : undefined;
}

function itemsLabel(db: Db, order: DbOrder): string {
  let label: string;
  if (order.lines.length === 1) {
    const line = order.lines[0]!;
    const unit = material(db, line.materialId)?.unit ?? "u";
    label = unit === "u" ? line.description : `${line.description} · ${formatNumber(line.quantity)} ${unit}`;
  } else {
    label = `${order.lines.length} materiales`;
  }
  if (db.pendingDelivery?.orderId === order.id) label += " · entrega por confirmar";
  return label;
}

export function linesLabel(db: Db, order: DbOrder): string {
  if (order.lines.length > 2) {
    return order.lines.map((l) => `${formatNumber(l.quantity)} ${material(db, l.materialId)?.shortName ?? l.description}`).join(" · ");
  }
  return order.lines
    .map((l) => {
      const unit = material(db, l.materialId)?.unit ?? "u";
      if (l.description.startsWith("Barra ")) return `${formatNumber(l.quantity)} barras ${l.description.slice(6)}`;
      return `${formatNumber(l.quantity)} ${unit === "u" ? "" : `${unit} de `}${l.description}`.replace("  ", " ");
    })
    .join(" · ");
}

export function toOrderSummary(db: Db, order: DbOrder): OrderSummary {
  const ordered = order.lines.reduce((s, l) => s + l.quantity, 0);
  const delivered = order.lines.reduce((s, l) => s + lineDelivered(db, l), 0);
  const total = orderTotal(order);
  const paid = orderPaid(db, order);
  return {
    id: order.id,
    number: order.number,
    supplier: { id: order.supplierId, name: supplierName(db, order.supplierId) },
    date: order.date,
    itemsLabel: itemsLabel(db, order),
    materialNames: order.lines.map((l) => `${l.description} ${material(db, l.materialId)?.name ?? ""}`),
    total,
    pendingPayment: total === null ? null : Math.max(total - paid, 0),
    delivery: { status: deliveryStatusOf(ordered, delivered), ordered, delivered, unit: "u", pendingLabel: remainingLabel(db, order) },
    payment: {
      status: paymentStatusOf(total, paid),
      paid,
      percent: total ? Math.round((paid / total) * 100) : null,
    },
    hasDocument: order.documentIds.length > 0,
    deliveryAwaitingConfirmation: db.pendingDelivery?.orderId === order.id,
  };
}

function documentById(db: Db, id?: string): DocumentRef | undefined {
  return id ? db.documents.find((d) => d.id === id) : undefined;
}

function toPayment(db: Db, p: Db["payments"][number]): Payment {
  return {
    id: p.id,
    supplierId: p.supplierId,
    orderId: p.orderId,
    orderNumber: p.orderId ? db.orders.find((o) => o.id === p.orderId)?.number : undefined,
    date: p.date,
    amount: p.amount,
    method: p.method,
    document: documentById(db, p.documentId),
  };
}

const byDateDesc = <T extends { date: string }>(a: T, b: T) => b.date.localeCompare(a.date);
const byAtDesc = (a: ActivityEvent, b: ActivityEvent) => b.at.localeCompare(a.at);

export function toOrderDetail(db: Db, order: DbOrder): OrderDetail {
  const summary = toOrderSummary(db, order);
  const deliveries = db.deliveries
    .filter((d) => d.orderId === order.id)
    .sort(byDateDesc)
    .map((d) => ({
      id: d.id,
      orderId: d.orderId,
      date: d.date,
      remito: d.remito,
      document: documentById(db, d.documentId),
      lines: d.lines.map((dl) => {
        const line = order.lines.find((l) => l.id === dl.orderLineId)!;
        const m = material(db, line.materialId);
        return { orderLineId: dl.orderLineId, materialName: m?.shortName ?? line.description, quantity: dl.quantity, unit: m?.unit ?? "u" };
      }),
    }));
  const payments = db.payments.filter((p) => p.orderId === order.id).sort(byDateDesc).map((p) => toPayment(db, p));
  const documents = db.documents.filter((d) => d.orderId === order.id).sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...summary,
    orderedBy: order.orderedBy,
    orderedByRole: order.orderedByRole,
    mode: order.mode,
    registeredAt: order.registeredAt,
    registeredVia: order.registeredVia,
    lines: order.lines.map((l) => ({
      id: l.id,
      materialId: l.materialId,
      materialName: l.description,
      spec: material(db, l.materialId)?.spec,
      quantity: l.quantity,
      unit: "u",
      unitPrice: l.unitPrice,
      amount: l.amount,
      delivered: lineDelivered(db, l),
    })),
    deliveries,
    payments,
    documents,
    history: db.activity.filter((a) => a.orderId === order.id && a.kind !== "documento_agregado" && a.kind !== "pago_registrado").sort(byAtDesc),
    notes: order.notes,
    supplierUnallocated: db.payments.filter((p) => p.supplierId === order.supplierId && p.orderId === null).reduce((s, p) => s + p.amount, 0),
  };
}

export function ordersOverview(db: Db): OrdersOverview {
  const orders = [...db.orders].sort((a, b) => b.date.localeCompare(a.date)).map((o) => toOrderSummary(db, o));
  const pendingDelivery = orders.filter((o) => o.delivery.status !== "entregado");
  const pendingPayment = orders.filter((o) => (o.pendingPayment ?? 0) > 0);
  const unallocated = db.payments.filter((p) => p.orderId === null);
  const numbers = pendingDelivery.map((o) => o.number);
  return {
    orders,
    supplierCount: new Set(db.orders.map((o) => o.supplierId)).size,
    firstOrderDate: orders.at(-1)?.date,
    totalOrdered: orders.reduce((s, o) => s + (o.total ?? 0), 0),
    unknownValueCount: orders.filter((o) => o.total === null).length,
    pendingDeliveryCount: pendingDelivery.length,
    pendingDeliveryLabel:
      numbers.length === 0 ? "Todo entregado" : numbers.length === 1 ? `Pedido ${numbers[0]}` : `Pedidos ${numbers.slice(0, -1).join(", ")} y ${numbers.at(-1)}`,
    pendingPaymentTotal: pendingPayment.reduce((s, o) => s + (o.pendingPayment ?? 0), 0),
    pendingPaymentCount: pendingPayment.length,
    unallocatedTotal: unallocated.reduce((s, p) => s + p.amount, 0),
    unallocatedSuppliers: [...new Set(unallocated.map((p) => supplierName(db, p.supplierId)))],
  };
}

export function toSupplierSummary(db: Db, supplierId: string): SupplierSummary {
  const supplier = db.suppliers.find((s) => s.id === supplierId)!;
  const orders = db.orders.filter((o) => o.supplierId === supplierId).map((o) => toOrderSummary(db, o));
  const payments = db.payments.filter((p) => p.supplierId === supplierId);
  const totalOrdered = orders.reduce((s, o) => s + (o.total ?? 0), 0);
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  return {
    ...supplier,
    totalOrdered,
    totalPaid,
    balance: totalOrdered - totalPaid,
    unallocatedPaid: payments.filter((p) => p.orderId === null).reduce((s, p) => s + p.amount, 0),
    openOrders: orders.filter((o) => o.delivery.status !== "entregado" || o.payment.status !== "pagado").length,
    pendingDeliveries: orders.filter((o) => o.delivery.status !== "entregado").length,
    ordersWithoutDocument: orders.filter((o) => !o.hasDocument).length,
  };
}

export function suppliersOverview(db: Db): SuppliersOverview {
  const suppliers = db.suppliers.map((s) => toSupplierSummary(db, s.id)).sort((a, b) => b.balance - a.balance || b.totalOrdered - a.totalOrdered);
  return {
    suppliers,
    orderCount: db.orders.length,
    totalOrdered: suppliers.reduce((s, x) => s + x.totalOrdered, 0),
    totalPaid: suppliers.reduce((s, x) => s + x.totalPaid, 0),
    totalBalance: suppliers.reduce((s, x) => s + x.balance, 0),
    unallocatedTotal: suppliers.reduce((s, x) => s + x.unallocatedPaid, 0),
  };
}

function pendingLinesFor(db: Db, order: DbOrder, includeComplete: boolean): PendingDeliveryLine[] {
  const lastDelivery = db.deliveries.filter((d) => d.orderId === order.id).sort(byDateDesc)[0];
  return order.lines
    .map((l) => ({
      orderId: order.id,
      orderNumber: order.number,
      materialName: l.description.replace(/^Barra /, "Barras "),
      ordered: l.quantity,
      delivered: lineDelivered(db, l),
      unit: material(db, l.materialId)?.unit ?? "u",
      lastDeliveryDate: lastDelivery?.date,
    }))
    .filter((l) => includeComplete || l.delivered < l.ordered)
    .sort((a, b) => a.delivered / a.ordered - b.delivered / b.ordered);
}

export function toSupplierDetail(db: Db, supplierId: string): SupplierDetail {
  const summary = toSupplierSummary(db, supplierId);
  const orders = db.orders.filter((o) => o.supplierId === supplierId).sort((a, b) => b.date.localeCompare(a.date));
  const payments = db.payments.filter((p) => p.supplierId === supplierId);
  const openOrders = orders.filter((o) => {
    const s = toOrderSummary(db, o);
    return s.delivery.status !== "entregado" || s.payment.status !== "pagado";
  });
  const notDelivered = orders.filter((o) => toOrderSummary(db, o).delivery.status !== "entregado");

  type Movement = { date: string; order: number; entry: Omit<LedgerEntry, "runningBalance"> };
  const movements: Movement[] = [
    ...orders.map((o, i) => ({
      date: o.date,
      order: i,
      entry: {
        id: `led-${o.id}`,
        date: o.date,
        type: "pedido" as const,
        title: `Pedido ${o.number}`,
        description: orderTotal(o) === null ? `${linesLabel(db, o)} · importe a confirmar` : linesLabel(db, o).replace(/barras /g, "").replace(/ x 12 m/g, ""),
        orderAmount: orderTotal(o) ?? undefined,
        orderId: o.id,
      },
    })),
    ...payments.map((p, i) => {
      const order = p.orderId ? db.orders.find((o) => o.id === p.orderId) : undefined;
      return {
        date: p.date,
        order: 100 + i,
        entry: {
          id: `led-${p.id}`,
          date: p.date,
          type: "pago" as const,
          title: order ? `Pago · pedido ${order.number}` : "Pago sin imputar",
          description: order
            ? `Imputado al pedido ${order.number} · ${paymentMethodLabel[p.method]}`
            : `${paymentMethodLabel[p.method]} · todavía sin imputar`,
          paymentAmount: p.amount,
          unallocated: !order,
          orderId: order?.id,
        },
      };
    }),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

  let running = 0;
  const ledger: LedgerEntry[] = movements.map(({ entry }) => {
    running += (entry.orderAmount ?? 0) - (entry.paymentAmount ?? 0);
    return { ...entry, runningBalance: running };
  });

  return {
    ...summary,
    openOrderList: openOrders.map((o) => ({ ...toOrderSummary(db, o), linesLabel: linesLabel(db, o), paid: orderPaid(db, o) })),
    pendingDeliveryLines: notDelivered.flatMap((o) => pendingLinesFor(db, o, false)),
    deliveryOrders: notDelivered.map((o) => ({
      orderId: o.id,
      orderNumber: o.number,
      status: toOrderSummary(db, o).delivery.status,
      lines: pendingLinesFor(db, o, true),
    })),
    unallocatedPayments: payments.filter((p) => p.orderId === null).map((p) => toPayment(db, p)),
    ledger,
    documents: db.documents.filter((d) => d.supplierId === supplierId).sort(byDateDesc),
    allocatedPaid: payments.filter((p) => p.orderId !== null).reduce((s, p) => s + p.amount, 0),
  };
}

function computationFor(db: Db, materialId: string, ordered: number): MaterialComputation | null {
  if (!db.computation.loaded) return null;
  const expected = db.computation.expected[materialId];
  if (expected === undefined) return null;
  const percent = Math.round((ordered / expected) * 100);
  const status = percent > 100 ? "supera" : percent === 100 ? "alcanzado" : percent >= NEAR_THRESHOLD ? "cerca" : "dentro";
  return { expected, percent, remaining: Math.max(expected - ordered, 0), variation: Math.max(ordered - expected, 0), status };
}

function materialLines(db: Db, materialId: string) {
  return db.orders.flatMap((o) => o.lines.filter((l) => l.materialId === materialId).map((l) => ({ order: o, line: l })));
}

export function toMaterialSummary(db: Db, m: DbMaterial): MaterialSummary {
  const lines = materialLines(db, m.id);
  const ordered = lines.reduce((s, x) => s + x.line.quantity, 0);
  const delivered = lines.reduce((s, x) => s + lineDelivered(db, x.line), 0);
  return {
    id: m.id,
    name: m.name,
    category: m.category,
    unit: m.unit,
    supplierName: supplierName(db, m.supplierId),
    ordered,
    delivered,
    pendingDelivery: Math.max(ordered - delivered, 0),
    lastOrderDate: lines.map((x) => x.order.date).sort().at(-1) ?? "",
    computation: computationFor(db, m.id, ordered),
  };
}

export function materialsOverview(db: Db): MaterialsOverview {
  const materials = db.materials.filter((m) => materialLines(db, m.id).length > 0).map((m) => toMaterialSummary(db, m));
  const counts = { supera: 0, cerca: 0, alcanzado: 0, dentro: 0, sin_computo: 0 };
  for (const m of materials) counts[m.computation?.status ?? "sin_computo"] += 1;
  return {
    computation: {
      loaded: db.computation.loaded,
      updatedAt: db.computation.updatedAt,
      version: db.computation.version,
      linkedMaterials: Object.keys(db.computation.expected).length,
    },
    materials,
    orderCount: db.orders.length,
    counts,
  };
}

export function toMaterialDetail(db: Db, m: DbMaterial): MaterialDetail {
  const summary = toMaterialSummary(db, m);
  const lines = materialLines(db, m.id).sort((a, b) => a.order.date.localeCompare(b.order.date));
  let cumulative = 0;
  const orders = lines.map(({ order, line }) => {
    cumulative += line.quantity;
    const s = toOrderSummary(db, order);
    return {
      orderId: order.id,
      orderNumber: order.number,
      date: order.date,
      delivery: s.delivery.status,
      payment: s.payment.status,
      ordered: line.quantity,
      delivered: lineDelivered(db, line),
      cumulative,
    };
  });
  const lineIds = new Set(lines.map((x) => x.line.id));
  const deliveries: MaterialDetail["deliveries"] = db.deliveries
    .filter((d) => d.lines.some((l) => lineIds.has(l.orderLineId)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      id: d.id,
      label: d.remito ? `Remito ${d.remito}` : "Entrega sin remito",
      date: d.date,
      quantity: d.lines.filter((l) => lineIds.has(l.orderLineId)).reduce((s, l) => s + l.quantity, 0),
      pending: false,
    }));
  for (const { order, line } of lines) {
    const rest = line.quantity - lineDelivered(db, line);
    if (rest > 0) deliveries.push({ id: `pend-${line.id}`, label: `Pedido ${order.number}`, date: null, quantity: rest, pending: true });
  }
  return {
    ...summary,
    spec: m.spec,
    usualSupplier: supplierName(db, m.supplierId),
    orders,
    deliveries,
    computationChanges: db.computation.changes[m.id] ?? [],
    reviewed: db.computation.reviewed.includes(m.id),
  };
}

export function attentionItems(db: Db): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (db.pendingDelivery) {
    const p = db.pendingDelivery;
    items.push({
      id: "att-confirmar",
      kind: "por_confirmar",
      group: "confirmar",
      title: "1 registro por confirmar",
      description: `Entrega de ${p.supplierName}${p.document ? ` · ${p.document.fileName}` : ""}`,
      chip: "1 por confirmar",
      link: { to: "/" },
    });
  }
  for (const m of materialsOverview(db).materials) {
    const c = m.computation;
    if (!c || c.status === "dentro" || db.computation.reviewed.includes(m.id)) continue;
    const short = m.name.replace(/ x 12 m$/, "").replace(/ 12x18x33$/, "");
    const link = { to: "/materiales/$materialId" as const, params: { materialId: m.id } };
    if (c.status === "supera")
      items.push({ id: `att-sup-${m.id}`, kind: "computo_supera", group: "computo", title: `${short} supera el cómputo`, description: `${formatNumber(m.ordered)} de ${formatNumber(c.expected)} ${m.unit} pedidas (${c.percent}%) · conviene revisar`, chip: "1 supera el cómputo", link });
    else if (c.status === "cerca")
      items.push({ id: `att-cer-${m.id}`, kind: "computo_cerca", group: "computo", title: `${short} cerca del cómputo`, description: `${formatNumber(m.ordered)} de ${formatNumber(c.expected)} ${m.unit} (${c.percent}%)`, link });
    else
      items.push({ id: `att-alc-${m.id}`, kind: "computo_alcanzado", group: "computo", title: `${short} alcanzó el cómputo`, description: `${formatNumber(m.ordered)} de ${formatNumber(c.expected)} ${m.unit}`, link });
  }
  const orders = db.orders.map((o) => toOrderSummary(db, o));
  for (const o of orders.filter((x) => x.delivery.status === "parcial"))
    items.push({ id: `att-par-${o.id}`, kind: "entrega_parcial", group: "entregas", title: `Pedido ${o.number} con entrega parcial`, description: `${o.delivery.pendingLabel ?? "Faltan materiales"} · ${o.supplier.name}`, chip: "1 entrega parcial", link: { to: "/pedidos/$orderId", params: { orderId: o.id } } });
  for (const o of orders.filter((x) => x.delivery.status === "entregado" && x.payment.status === "sin_pagos"))
    items.push({ id: `att-sp-${o.id}`, kind: "entregado_sin_pagos", group: "pagos", title: `Pedido ${o.number} entregado, sin pagos`, description: `${o.total !== null ? formatMoney(o.total) : "Sin importe"} · ${o.supplier.name}`, chip: "Entregado sin pagos", link: { to: "/pedidos/$orderId", params: { orderId: o.id } } });
  for (const s of db.suppliers) {
    const sum = toSupplierSummary(db, s.id);
    if (sum.unallocatedPaid > 0)
      items.push({ id: `att-imp-${s.id}`, kind: "pago_sin_imputar", group: "pagos", title: `${formatMoney(sum.unallocatedPaid)} sin imputar`, description: `${s.name} · saldo ${formatMoney(sum.balance)}`, chip: "Pago sin imputar", link: { to: "/proveedores/$supplierId", params: { supplierId: s.id } } });
  }
  for (const o of orders.filter((x) => !x.hasDocument))
    items.push({ id: `att-doc-${o.id}`, kind: "sin_comprobante", group: "documentos", title: `Pedido ${o.number} sin comprobante`, description: o.supplier.name, link: { to: "/pedidos/$orderId", params: { orderId: o.id } } });
  const priority: AttentionItem["kind"][] = ["por_confirmar", "entrega_parcial", "entregado_sin_pagos", "pago_sin_imputar", "computo_supera", "sin_comprobante", "computo_cerca", "computo_alcanzado"];
  return items.sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
}

export function dashboard(db: Db): DashboardSummary {
  const sup = suppliersOverview(db);
  return {
    totalBalance: sup.totalBalance,
    suppliersWithBalance: sup.suppliers.filter((s) => s.balance > 0).length,
    unallocatedTotal: sup.unallocatedTotal,
    attention: attentionItems(db),
    recentActivity: [...db.activity].sort(byAtDesc).slice(0, 3),
    computation: materialsOverview(db).computation,
    hasData: db.orders.length > 0,
  };
}

export { byAtDesc };
