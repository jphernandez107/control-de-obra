import type {
  ActivityChange,
  ActivityEvent,
  ActivityKind,
  AttentionItem,
  ComputationChange,
  ComputationInfo,
  DashboardSummary,
  Delivery as DeliveryDto,
  DeliveryStatus,
  DocumentKind,
  DocumentRef,
  LedgerEntry,
  MaterialComputation,
  MaterialDetail,
  MaterialSummary,
  MaterialsOverview,
  OrderDetail,
  OrderLine,
  OrderSummary,
  OrdersOverview,
  Payment as PaymentDto,
  PaymentMethod,
  PaymentStatus,
  PendingDeliveryLine,
  StatusTag,
  SupplierDetail,
  SupplierSummary,
  SuppliersOverview,
} from "../../src/domain/types";
import { formatMoney, formatNumber, paymentMethodLabel } from "../../src/domain/format";
import { convertMilli, fromMilli } from "./quantity";
import { localDate, localDateTime } from "./time";
import type {
  AuditRow,
  Delivery,
  DocumentRow,
  Material,
  Order,
  OrderItem,
  Payment,
  Snapshot,
  Supplier,
} from "../repositories/snapshot";

// Pure derivations: snapshot of persisted records → the read models the UI
// renders. Statuses (delivery, payment, computation) and balances are always
// computed here, never stored.

export const NEAR_THRESHOLD_PCT = 85;

const DOC_KIND: Record<string, DocumentKind> = {
  order_proof: "comprobante_pedido",
  delivery_proof: "remito",
  payment_proof: "comprobante_pago",
  computation: "computo",
  other: "otro",
};

export function deliveryStatusOf(orderedMilli: number, deliveredMilli: number): DeliveryStatus {
  if (deliveredMilli <= 0) return "pendiente";
  if (deliveredMilli < orderedMilli) return "parcial";
  return "entregado";
}

export function paymentStatusOf(valueMinor: number | null, paidMinor: number): PaymentStatus {
  if (paidMinor <= 0) return "sin_pagos";
  if (valueMinor !== null && paidMinor >= valueMinor) return "pagado";
  return "parcial";
}

function sizeLabel(bytes: number): string {
  const kb = bytes / 1024;
  return kb > 1024 ? `${(kb / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(kb))} KB`;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/** Indexes over a snapshot plus every derived figure the read models need. */
export class Ledger {
  readonly s: Snapshot;
  readonly tz: string;
  private supplierById: Map<string, Supplier>;
  private materialById: Map<string, Material>;
  private orderById: Map<string, Order>;
  private itemsByOrder: Map<string, OrderItem[]>;
  private itemById: Map<string, OrderItem>;
  private deliveredByItem = new Map<string, number>();
  private deliveriesByOrder: Map<string | null, Delivery[]>;
  private allocationsByOrder: Map<string, Snapshot["allocations"]>;
  private allocationsByPayment: Map<string, Snapshot["allocations"]>;
  private unitLabels: Map<string, string>;
  private aliasesByMaterial: Map<string, string[]>;

  constructor(snapshot: Snapshot) {
    this.s = snapshot;
    this.tz = snapshot.project.timezone;
    this.supplierById = new Map(snapshot.suppliers.map((x) => [x.id, x]));
    this.materialById = new Map(snapshot.materials.map((x) => [x.id, x]));
    this.orderById = new Map(snapshot.orders.map((x) => [x.id, x]));
    this.itemsByOrder = groupBy([...snapshot.orderItems].sort((a, b) => a.position - b.position), (i) => i.orderId);
    this.itemById = new Map(snapshot.orderItems.map((i) => [i.id, i]));
    for (const di of snapshot.deliveryItems) {
      if (di.orderItemId) this.deliveredByItem.set(di.orderItemId, (this.deliveredByItem.get(di.orderItemId) ?? 0) + di.quantityMilli);
    }
    this.deliveriesByOrder = groupBy(snapshot.deliveries, (d) => d.orderId);
    this.allocationsByOrder = groupBy(snapshot.allocations, (a) => a.orderId);
    this.allocationsByPayment = groupBy(snapshot.allocations, (a) => a.paymentId);
    this.unitLabels = new Map(snapshot.units.map((u) => [u.code, u.label]));
    this.aliasesByMaterial = new Map();
    for (const a of snapshot.aliases) this.aliasesByMaterial.set(a.materialId, [...(this.aliasesByMaterial.get(a.materialId) ?? []), a.alias]);
  }

  // ------------------------------------------------------------ primitives

  unitLabel(code: string): string {
    return this.unitLabels.get(code) ?? code;
  }
  supplier(id: string): Supplier | undefined {
    return this.supplierById.get(id);
  }
  supplierName(id: string): string {
    return this.supplierById.get(id)?.name ?? "Proveedor";
  }
  material(id: string): Material | undefined {
    return this.materialById.get(id);
  }
  materialAliases(id: string): string[] {
    return this.aliasesByMaterial.get(id) ?? [];
  }
  order(id: string): Order | undefined {
    return this.orderById.get(id);
  }
  orderItem(id: string): OrderItem | undefined {
    return this.itemById.get(id);
  }
  items(orderId: string): OrderItem[] {
    return this.itemsByOrder.get(orderId) ?? [];
  }
  orderNumber(order: Order): string {
    return order.reference ?? `#${order.internalNumber}`;
  }
  deliveredMilli(itemId: string): number {
    return this.deliveredByItem.get(itemId) ?? 0;
  }
  remainingMilli(item: OrderItem): number {
    return Math.max(item.quantityMilli - this.deliveredMilli(item.id), 0);
  }
  deliveriesOf(orderId: string): Delivery[] {
    return this.deliveriesByOrder.get(orderId) ?? [];
  }
  /** Known order value: stated total, else the sum of line totals when every line is priced; otherwise null. */
  orderValue(order: Order): number | null {
    if (order.statedTotalMinor !== null) return order.statedTotalMinor;
    const items = this.items(order.id);
    if (!items.length || items.some((i) => i.lineTotalMinor === null)) return null;
    return items.reduce((s, i) => s + (i.lineTotalMinor ?? 0), 0);
  }
  /** Only payments explicitly allocated to this order count toward its paid amount. */
  orderPaid(orderId: string): number {
    return (this.allocationsByOrder.get(orderId) ?? []).reduce((s, a) => s + a.amountMinor, 0);
  }
  orderPending(order: Order): number | null {
    const value = this.orderValue(order);
    return value === null ? null : Math.max(value - this.orderPaid(order.id), 0);
  }
  paymentAllocated(paymentId: string): number {
    return (this.allocationsByPayment.get(paymentId) ?? []).reduce((s, a) => s + a.amountMinor, 0);
  }
  paymentUnallocated(payment: Payment): number {
    return payment.amountMinor - this.paymentAllocated(payment.id);
  }
  orderDeliveryStatus(order: Order): DeliveryStatus {
    const items = this.items(order.id);
    const ordered = items.reduce((s, i) => s + i.quantityMilli, 0);
    const delivered = items.reduce((s, i) => s + Math.min(this.deliveredMilli(i.id), i.quantityMilli), 0);
    return deliveryStatusOf(ordered, delivered);
  }
  orderPaymentStatus(order: Order): PaymentStatus {
    return paymentStatusOf(this.orderValue(order), this.orderPaid(order.id));
  }
  localDate(iso: string): string {
    return localDate(iso, this.tz);
  }

  /** Quantity expressed in the material's base unit, or null when no conversion is defined. */
  inBaseUnit(materialId: string, milli: number, unit: string): number | null {
    const material = this.material(materialId);
    if (!material) return null;
    if (unit === material.baseUnit) return milli;
    const direct =
      this.s.conversions.find((c) => c.materialId === materialId && c.fromUnit === unit && c.toUnit === material.baseUnit) ??
      this.s.conversions.find((c) => c.materialId === null && c.fromUnit === unit && c.toUnit === material.baseUnit);
    if (direct) return convertMilli(milli, direct.factorNum, direct.factorDen);
    const inverse =
      this.s.conversions.find((c) => c.materialId === materialId && c.fromUnit === material.baseUnit && c.toUnit === unit) ??
      this.s.conversions.find((c) => c.materialId === null && c.fromUnit === material.baseUnit && c.toUnit === unit);
    if (inverse) return convertMilli(milli, inverse.factorDen, inverse.factorNum);
    return null;
  }

  // ------------------------------------------------------------ documents

  documentLinksFor(target: { orderId?: string; deliveryId?: string; paymentId?: string }): DocumentRow[] {
    const ids = this.s.documentLinks
      .filter((l) => (target.orderId && l.orderId === target.orderId) || (target.deliveryId && l.deliveryId === target.deliveryId) || (target.paymentId && l.paymentId === target.paymentId))
      .map((l) => l.documentId);
    return this.s.documents.filter((d) => ids.includes(d.id));
  }

  /** Order linked to a document, directly or through a delivery/payment. */
  private documentOrder(doc: DocumentRow): Order | undefined {
    for (const l of this.s.documentLinks.filter((x) => x.documentId === doc.id)) {
      if (l.orderId) return this.order(l.orderId);
      if (l.deliveryId) {
        const d = this.s.deliveries.find((x) => x.id === l.deliveryId);
        if (d?.orderId) return this.order(d.orderId);
      }
      if (l.paymentId) {
        const a = this.allocationsByPayment.get(l.paymentId)?.[0];
        if (a) return this.order(a.orderId);
      }
    }
    return undefined;
  }

  documentRef(doc: DocumentRow): DocumentRef {
    const order = this.documentOrder(doc);
    return {
      id: doc.id,
      fileName: doc.fileName,
      kind: DOC_KIND[doc.kind] ?? "otro",
      format: doc.mimeType === "application/pdf" ? "pdf" : "image",
      sizeLabel: sizeLabel(doc.sizeBytes),
      date: doc.documentDate ?? this.localDate(doc.uploadedAt),
      supplierId: doc.supplierId ?? order?.supplierId ?? undefined,
      orderId: order?.id,
      orderNumber: order ? this.orderNumber(order) : undefined,
      mimeType: doc.mimeType,
      url: `/api/documents/${doc.id}/file`,
    };
  }

  /** Every document attached to the order, its deliveries, or payments allocated to it. */
  orderDocuments(order: Order): DocumentRow[] {
    const deliveryIds = this.deliveriesOf(order.id).map((d) => d.id);
    const paymentIds = (this.allocationsByOrder.get(order.id) ?? []).map((a) => a.paymentId);
    const ids = new Set(
      this.s.documentLinks
        .filter((l) => l.orderId === order.id || (l.deliveryId && deliveryIds.includes(l.deliveryId)) || (l.paymentId && paymentIds.includes(l.paymentId)))
        .map((l) => l.documentId),
    );
    return this.s.documents.filter((d) => ids.has(d.id));
  }

  hasOrderProof(order: Order): boolean {
    return this.s.documentLinks.some((l) => l.orderId === order.id);
  }

  // ------------------------------------------------------------ orders

  private shortMaterial(item: OrderItem): string {
    return this.material(item.materialId)?.shortName ?? item.description;
  }

  pendingLabel(order: Order): string | undefined {
    const parts = this.items(order.id)
      .map((i) => ({ i, rest: this.remainingMilli(i) }))
      .filter(({ rest }) => rest > 0)
      .map(({ i, rest }) => `${formatNumber(fromMilli(rest))} ${this.unitLabel(i.unit)} ${this.shortMaterial(i)}`);
    return parts.length ? `Faltan ${parts.join(" y ")}` : undefined;
  }

  itemsLabel(order: Order): string {
    const items = this.items(order.id);
    let label: string;
    if (items.length === 1) {
      const i = items[0]!;
      label = `${this.material(i.materialId)?.name ?? i.description} · ${formatNumber(fromMilli(i.quantityMilli))} ${this.unitLabel(i.unit)}`;
    } else label = `${items.length} materiales`;
    if (this.awaitingDelivery(order.id)) label += " · entrega por confirmar";
    return label;
  }

  linesLabel(order: Order): string {
    return this.items(order.id)
      .map((i) => `${formatNumber(fromMilli(i.quantityMilli))} ${this.unitLabel(i.unit)} ${this.shortMaterial(i)}`)
      .join(" · ");
  }

  private awaitingDelivery(orderId: string): boolean {
    return this.s.pendingInterpretations.some((p) => p.intent === "register_delivery" && p.proposal.includes(`"orderId":"${orderId}"`));
  }

  toOrderSummary(order: Order): OrderSummary {
    const items = this.items(order.id);
    const orderedMilli = items.reduce((s, i) => s + i.quantityMilli, 0);
    const deliveredMilli = items.reduce((s, i) => s + Math.min(this.deliveredMilli(i.id), i.quantityMilli), 0);
    const units = new Set(items.map((i) => i.unit));
    const total = this.orderValue(order);
    const paid = this.orderPaid(order.id);
    return {
      id: order.id,
      number: this.orderNumber(order),
      supplier: { id: order.supplierId, name: this.supplierName(order.supplierId) },
      date: order.orderDate,
      itemsLabel: this.itemsLabel(order),
      materialNames: items.map((i) => `${i.description} ${this.material(i.materialId)?.name ?? ""}`),
      total,
      pendingPayment: total === null ? null : Math.max(total - paid, 0),
      delivery: {
        status: deliveryStatusOf(orderedMilli, deliveredMilli),
        ordered: fromMilli(orderedMilli),
        delivered: fromMilli(deliveredMilli),
        unit: units.size === 1 ? this.unitLabel([...units][0]!) : "u",
        pendingLabel: this.pendingLabel(order),
      },
      payment: {
        status: paymentStatusOf(total, paid),
        paid,
        percent: total ? Math.min(Math.round((paid * 100) / total), 100) : null,
      },
      hasDocument: this.hasOrderProof(order),
      deliveryAwaitingConfirmation: this.awaitingDelivery(order.id),
    };
  }

  toPaymentDto(p: Payment, orderContext?: string): PaymentDto {
    const allocations = (this.allocationsByPayment.get(p.id) ?? []).map((a) => {
      const order = this.order(a.orderId)!;
      return { orderId: a.orderId, orderNumber: this.orderNumber(order), amount: a.amountMinor };
    });
    const single = allocations.length === 1 ? allocations[0] : undefined;
    const doc = this.documentLinksFor({ paymentId: p.id })[0];
    return {
      id: p.id,
      supplierId: p.supplierId,
      orderId: single?.orderId ?? null,
      orderNumber: single?.orderNumber,
      date: p.paymentDate,
      amount: p.amountMinor,
      method: (p.method ?? "otro") as PaymentMethod,
      reference: p.reference ?? undefined,
      document: doc ? this.documentRef(doc) : undefined,
      allocations,
      unallocatedAmount: this.paymentUnallocated(p),
      allocatedToOrder: orderContext ? allocations.filter((a) => a.orderId === orderContext).reduce((s, a) => s + a.amount, 0) : undefined,
    };
  }

  toOrderDetail(order: Order, audit: AuditRow[]): OrderDetail {
    const summary = this.toOrderSummary(order);
    const items = this.items(order.id);
    const deliveries: DeliveryDto[] = this.deliveriesOf(order.id)
      .sort((a, b) => b.deliveryDate.localeCompare(a.deliveryDate) || b.createdAt.localeCompare(a.createdAt))
      .map((d) => {
        const doc = this.documentLinksFor({ deliveryId: d.id })[0];
        return {
          id: d.id,
          orderId: order.id,
          date: d.deliveryDate,
          remito: d.reference,
          document: doc ? this.documentRef(doc) : undefined,
          lines: this.s.deliveryItems
            .filter((di) => di.deliveryId === d.id)
            .map((di) => {
              const item = di.orderItemId ? this.orderItem(di.orderItemId) : undefined;
              return {
                orderLineId: di.orderItemId ?? "",
                materialName: item ? this.shortMaterial(item) : this.material(di.materialId)?.shortName ?? "Material",
                quantity: fromMilli(di.quantityMilli),
                unit: this.unitLabel(di.unit),
              };
            }),
        };
      });
    const paymentIds = new Set((this.allocationsByOrder.get(order.id) ?? []).map((a) => a.paymentId));
    const payments = this.s.payments
      .filter((p) => paymentIds.has(p.id))
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
      .map((p) => this.toPaymentDto(p, order.id));
    const orderedBy = order.orderedByUserId ? this.s.users.find((u) => u.id === order.orderedByUserId) : undefined;
    const lines: OrderLine[] = items.map((i) => ({
      id: i.id,
      materialId: i.materialId,
      materialName: i.description,
      spec: this.material(i.materialId)?.spec ?? undefined,
      quantity: fromMilli(i.quantityMilli),
      unit: this.unitLabel(i.unit),
      unitPrice: i.unitPriceMinor,
      amount: i.lineTotalMinor,
      delivered: fromMilli(this.deliveredMilli(i.id)),
    }));
    return {
      ...summary,
      reference: order.reference,
      internalNumber: order.internalNumber,
      statedTotal: order.statedTotalMinor,
      orderedBy: order.orderedByName ?? orderedBy?.name ?? "Sin indicar",
      orderedByRole: orderedBy?.role,
      mode: order.purchaseMode as OrderDetail["mode"],
      registeredAt: this.localDate(order.createdAt),
      registeredVia: order.source === "manual" ? "manual" : "asistente",
      lines,
      deliveries,
      payments,
      documents: this.orderDocuments(order)
        .map((d) => this.documentRef(d))
        .sort((a, b) => a.date.localeCompare(b.date)),
      history: audit
        .filter((a) => a.orderId === order.id)
        .map((a) => this.toActivity(a))
        .filter((e) => e.kind !== "documento_agregado" && e.kind !== "pago_registrado")
        .sort((a, b) => b.at.localeCompare(a.at)),
      notes: order.notes ?? undefined,
      supplierUnallocated: this.s.payments.filter((p) => p.supplierId === order.supplierId).reduce((s, p) => s + this.paymentUnallocated(p), 0),
    };
  }

  ordersOverview(): OrdersOverview {
    const orders = [...this.s.orders]
      .sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.internalNumber - a.internalNumber)
      .map((o) => this.toOrderSummary(o));
    const pendingDelivery = orders.filter((o) => o.delivery.status !== "entregado");
    const pendingPayment = orders.filter((o) => (o.pendingPayment ?? 0) > 0);
    const unallocated = this.s.payments.filter((p) => this.paymentUnallocated(p) > 0);
    const numbers = pendingDelivery.map((o) => o.number);
    return {
      orders,
      supplierCount: new Set(this.s.orders.map((o) => o.supplierId)).size,
      firstOrderDate: orders.at(-1)?.date,
      totalOrdered: orders.reduce((s, o) => s + (o.total ?? 0), 0),
      unknownValueCount: orders.filter((o) => o.total === null).length,
      pendingDeliveryCount: pendingDelivery.length,
      pendingDeliveryLabel:
        numbers.length === 0 ? "Todo entregado" : numbers.length === 1 ? `Pedido ${numbers[0]}` : `Pedidos ${numbers.slice(0, -1).join(", ")} y ${numbers.at(-1)}`,
      pendingPaymentTotal: pendingPayment.reduce((s, o) => s + (o.pendingPayment ?? 0), 0),
      pendingPaymentCount: pendingPayment.length,
      unallocatedTotal: unallocated.reduce((s, p) => s + this.paymentUnallocated(p), 0),
      unallocatedSuppliers: [...new Set(unallocated.map((p) => this.supplierName(p.supplierId)))],
    };
  }

  // ------------------------------------------------------------ suppliers

  /**
   * Supplier current account. Balance = known order values − every payment
   * (allocated or not). Orders with unknown value are counted separately so
   * the total is never presented as more precise than it is.
   */
  toSupplierSummary(supplier: Supplier): SupplierSummary {
    const orders = this.s.orders.filter((o) => o.supplierId === supplier.id);
    const payments = this.s.payments.filter((p) => p.supplierId === supplier.id);
    const values = orders.map((o) => this.orderValue(o));
    const totalOrdered = values.reduce<number>((s, v) => s + (v ?? 0), 0);
    const totalPaid = payments.reduce((s, p) => s + p.amountMinor, 0);
    const summaries = orders.map((o) => ({ o, delivery: this.orderDeliveryStatus(o), payment: this.orderPaymentStatus(o) }));
    return {
      id: supplier.id,
      name: supplier.name,
      initials: initials(supplier.name),
      category: supplier.category,
      contactName: supplier.contactName ?? undefined,
      phone: supplier.phone ?? undefined,
      totalOrdered,
      unknownValueOrders: values.filter((v) => v === null).length,
      totalPaid,
      balance: totalOrdered - totalPaid,
      unallocatedPaid: payments.reduce((s, p) => s + this.paymentUnallocated(p), 0),
      openOrders: summaries.filter((x) => x.delivery !== "entregado" || x.payment !== "pagado").length,
      pendingDeliveries: summaries.filter((x) => x.delivery !== "entregado").length,
      ordersWithoutDocument: orders.filter((o) => !this.hasOrderProof(o)).length,
    };
  }

  suppliersOverview(): SuppliersOverview {
    const suppliers = this.s.suppliers.map((s) => this.toSupplierSummary(s)).sort((a, b) => b.balance - a.balance || b.totalOrdered - a.totalOrdered);
    return {
      suppliers,
      orderCount: this.s.orders.length,
      totalOrdered: suppliers.reduce((s, x) => s + x.totalOrdered, 0),
      totalPaid: suppliers.reduce((s, x) => s + x.totalPaid, 0),
      totalBalance: suppliers.reduce((s, x) => s + x.balance, 0),
      unallocatedTotal: suppliers.reduce((s, x) => s + x.unallocatedPaid, 0),
    };
  }

  private pendingLinesFor(order: Order, includeComplete: boolean): PendingDeliveryLine[] {
    const last = [...this.deliveriesOf(order.id)].sort((a, b) => b.deliveryDate.localeCompare(a.deliveryDate))[0];
    return this.items(order.id)
      .map((i) => ({
        orderId: order.id,
        orderNumber: this.orderNumber(order),
        materialName: this.material(i.materialId)?.name ?? i.description,
        ordered: fromMilli(i.quantityMilli),
        delivered: fromMilli(Math.min(this.deliveredMilli(i.id), i.quantityMilli)),
        unit: this.unitLabel(i.unit),
        lastDeliveryDate: last?.deliveryDate,
      }))
      .filter((l) => includeComplete || l.delivered < l.ordered)
      .sort((a, b) => a.delivered / a.ordered - b.delivered / b.ordered);
  }

  toSupplierDetail(supplier: Supplier): SupplierDetail {
    const summary = this.toSupplierSummary(supplier);
    const orders = this.s.orders.filter((o) => o.supplierId === supplier.id).sort((a, b) => b.orderDate.localeCompare(a.orderDate));
    const payments = this.s.payments.filter((p) => p.supplierId === supplier.id);
    const open = orders.filter((o) => this.orderDeliveryStatus(o) !== "entregado" || this.orderPaymentStatus(o) !== "pagado");
    const notDelivered = orders.filter((o) => this.orderDeliveryStatus(o) !== "entregado");

    type Movement = { date: string; seq: string; entry: Omit<LedgerEntry, "runningBalance"> };
    const movements: Movement[] = [
      ...orders.map((o) => {
        const value = this.orderValue(o);
        return {
          date: o.orderDate,
          seq: `0${o.createdAt}`,
          entry: {
            id: `led-${o.id}`,
            date: o.orderDate,
            type: "pedido" as const,
            title: `Pedido ${this.orderNumber(o)}`,
            description: value === null ? `${this.linesLabel(o)} · importe a confirmar` : this.linesLabel(o),
            orderAmount: value ?? undefined,
            orderId: o.id,
          },
        };
      }),
      ...payments.map((p) => {
        const dto = this.toPaymentDto(p);
        const method = paymentMethodLabel[dto.method];
        const parts = dto.allocations.map((a) => `pedido ${a.orderNumber}`);
        let title: string;
        let description: string;
        if (!dto.allocations.length) {
          title = "Pago sin imputar";
          description = `${method} · todavía sin imputar`;
        } else if (dto.allocations.length === 1 && dto.unallocatedAmount === 0) {
          title = `Pago · pedido ${dto.allocations[0]!.orderNumber}`;
          description = `Imputado al pedido ${dto.allocations[0]!.orderNumber} · ${method}`;
        } else {
          title = `Pago · ${parts.join(", ")}`;
          description = `${dto.allocations.map((a) => `${formatMoney(a.amount)} al pedido ${a.orderNumber}`).join(" · ")}${dto.unallocatedAmount ? ` · ${formatMoney(dto.unallocatedAmount)} sin imputar` : ""} · ${method}`;
        }
        return {
          date: p.paymentDate,
          seq: `1${p.createdAt}`,
          entry: {
            id: `led-${p.id}`,
            date: p.paymentDate,
            type: "pago" as const,
            title,
            description,
            paymentAmount: p.amountMinor,
            unallocated: dto.allocations.length === 0,
            orderId: dto.orderId ?? undefined,
          },
        };
      }),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.seq.localeCompare(b.seq));

    let running = 0;
    const ledger = movements.map(({ entry }) => {
      running += (entry.orderAmount ?? 0) - (entry.paymentAmount ?? 0);
      return { ...entry, runningBalance: running };
    });

    const supplierDocIds = new Set<string>();
    for (const d of this.s.documents) if (d.supplierId === supplier.id) supplierDocIds.add(d.id);
    for (const o of orders) for (const d of this.orderDocuments(o)) supplierDocIds.add(d.id);
    for (const p of payments) for (const d of this.documentLinksFor({ paymentId: p.id })) supplierDocIds.add(d.id);

    return {
      ...summary,
      openOrderList: open.map((o) => ({ ...this.toOrderSummary(o), linesLabel: this.linesLabel(o), paid: this.orderPaid(o.id) })),
      pendingDeliveryLines: notDelivered.flatMap((o) => this.pendingLinesFor(o, false)),
      deliveryOrders: notDelivered.map((o) => ({ orderId: o.id, orderNumber: this.orderNumber(o), status: this.orderDeliveryStatus(o), lines: this.pendingLinesFor(o, true) })),
      unallocatedPayments: payments.filter((p) => this.paymentUnallocated(p) > 0).map((p) => this.toPaymentDto(p)),
      ledger,
      documents: this.s.documents
        .filter((d) => supplierDocIds.has(d.id))
        .map((d) => this.documentRef(d))
        .sort((a, b) => b.date.localeCompare(a.date)),
      allocatedPaid: payments.reduce((s, p) => s + this.paymentAllocated(p.id), 0),
    };
  }

  // ------------------------------------------------------------ materials

  /** Ordered and delivered quantities of a material in its base unit (historical records, no reassignment needed). */
  materialTotals(materialId: string) {
    let orderedMilli = 0;
    let deliveredMilli = 0;
    let unconverted = 0;
    const lines: { order: Order; item: OrderItem }[] = [];
    for (const item of this.s.orderItems) {
      if (item.materialId !== materialId) continue;
      const order = this.order(item.orderId);
      if (!order) continue;
      lines.push({ order, item });
      const q = this.inBaseUnit(materialId, item.quantityMilli, item.unit);
      if (q === null) unconverted++;
      else orderedMilli += q;
    }
    for (const di of this.s.deliveryItems) {
      if (di.materialId !== materialId) continue;
      const q = this.inBaseUnit(materialId, di.quantityMilli, di.unit);
      if (q === null) unconverted++;
      else deliveredMilli += q;
    }
    return { orderedMilli, deliveredMilli, unconverted, lines };
  }

  computationItem(materialId: string) {
    return this.s.computationItems.find((c) => c.materialId === materialId);
  }

  /** Expected quantity including waste allowance, in the material's base unit. */
  expectedMilli(materialId: string): number | null {
    const c = this.computationItem(materialId);
    if (!c) return null;
    const base = this.inBaseUnit(materialId, c.expectedQuantityMilli, c.unit);
    if (base === null) return null;
    return Number((BigInt(base) * BigInt(10_000 + c.wasteBasisPoints) + 5_000n) / 10_000n);
  }

  computationFor(materialId: string, orderedMilli: number): MaterialComputation | null {
    const expected = this.expectedMilli(materialId);
    if (expected === null || expected <= 0) return null;
    const status: MaterialComputation["status"] =
      orderedMilli > expected ? "supera" : orderedMilli === expected ? "alcanzado" : orderedMilli * 100 >= expected * NEAR_THRESHOLD_PCT ? "cerca" : "dentro";
    return {
      expected: fromMilli(expected),
      percent: Math.round((orderedMilli * 100) / expected),
      remaining: fromMilli(Math.max(expected - orderedMilli, 0)),
      variation: fromMilli(Math.max(orderedMilli - expected, 0)),
      status,
    };
  }

  toMaterialSummary(m: Material): MaterialSummary {
    const t = this.materialTotals(m.id);
    const lastOrder = t.lines.map((x) => x.order).sort((a, b) => b.orderDate.localeCompare(a.orderDate))[0];
    const supplierId = m.usualSupplierId ?? lastOrder?.supplierId;
    return {
      id: m.id,
      name: m.name,
      category: m.category,
      unit: this.unitLabel(m.baseUnit),
      supplierName: supplierId ? this.supplierName(supplierId) : "Sin proveedor",
      ordered: fromMilli(t.orderedMilli),
      delivered: fromMilli(t.deliveredMilli),
      pendingDelivery: fromMilli(Math.max(t.orderedMilli - t.deliveredMilli, 0)),
      lastOrderDate: lastOrder?.orderDate ?? "",
      computation: this.computationFor(m.id, t.orderedMilli),
    };
  }

  private trackedMaterials(): Material[] {
    const used = new Set<string>([
      ...this.s.orderItems.map((i) => i.materialId),
      ...this.s.deliveryItems.map((i) => i.materialId),
      ...this.s.computationItems.map((i) => i.materialId),
    ]);
    return this.s.materials.filter((m) => used.has(m.id));
  }

  computationInfo(): ComputationInfo {
    const c = this.s.computation;
    if (!c || !this.s.computationItems.length) return { loaded: false };
    return { loaded: true, updatedAt: this.localDate(c.updatedAt), version: c.version, linkedMaterials: this.s.computationItems.length };
  }

  materialsOverview(): MaterialsOverview {
    const materials = this.trackedMaterials().map((m) => this.toMaterialSummary(m));
    const counts = { supera: 0, cerca: 0, alcanzado: 0, dentro: 0, sin_computo: 0 };
    for (const m of materials) counts[m.computation?.status ?? "sin_computo"] += 1;
    return { computation: this.computationInfo(), materials, orderCount: this.s.orders.length, counts };
  }

  isReviewed(materialId: string, orderedMilli: number): boolean {
    const c = this.computationItem(materialId);
    return c?.reviewedOrderedMilli !== null && c?.reviewedOrderedMilli !== undefined && c.reviewedOrderedMilli >= orderedMilli;
  }

  toMaterialDetail(m: Material): MaterialDetail {
    const summary = this.toMaterialSummary(m);
    const t = this.materialTotals(m.id);
    const lines = [...t.lines].sort((a, b) => a.order.orderDate.localeCompare(b.order.orderDate));
    let cumulative = 0;
    const orders = lines.map(({ order, item }) => {
      cumulative += item.quantityMilli;
      return {
        orderId: order.id,
        orderNumber: this.orderNumber(order),
        date: order.orderDate,
        delivery: this.orderDeliveryStatus(order),
        payment: this.orderPaymentStatus(order),
        ordered: fromMilli(item.quantityMilli),
        delivered: fromMilli(this.deliveredMilli(item.id)),
        cumulative: fromMilli(cumulative),
      };
    });
    const deliveryIds = new Set(this.s.deliveryItems.filter((d) => d.materialId === m.id).map((d) => d.deliveryId));
    const deliveries: MaterialDetail["deliveries"] = this.s.deliveries
      .filter((d) => deliveryIds.has(d.id))
      .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))
      .map((d) => ({
        id: d.id,
        label: d.reference ? `Remito ${d.reference}` : "Entrega sin remito",
        date: d.deliveryDate,
        quantity: fromMilli(this.s.deliveryItems.filter((x) => x.deliveryId === d.id && x.materialId === m.id).reduce((s, x) => s + x.quantityMilli, 0)),
        pending: false,
      }));
    for (const { order, item } of lines) {
      const rest = this.remainingMilli(item);
      if (rest > 0) deliveries.push({ id: `pend-${item.id}`, label: `Pedido ${this.orderNumber(order)}`, date: null, quantity: fromMilli(rest), pending: true });
    }
    const changes: ComputationChange[] = this.s.computationRevisions
      .filter((r) => r.materialId === m.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => {
        const actor = this.s.users.find((u) => u.id === r.actorUserId);
        return {
          date: this.localDate(r.createdAt),
          before: r.previousQuantityMilli === null ? 0 : fromMilli(r.previousQuantityMilli),
          after: fromMilli(r.newQuantityMilli),
          by: actor?.name ?? "Sistema",
          byRole: actor ? capitalize(actor.role) : undefined,
        };
      });
    const lastOrder = lines.at(-1)?.order;
    const usual = m.usualSupplierId ?? lastOrder?.supplierId;
    return {
      ...summary,
      spec: m.spec ?? undefined,
      usualSupplier: usual ? this.supplierName(usual) : "Sin proveedor",
      orders,
      deliveries,
      computationChanges: changes,
      reviewed: this.isReviewed(m.id, t.orderedMilli),
    };
  }

  // ------------------------------------------------------------ attention & dashboard

  attentionItems(): AttentionItem[] {
    const items: AttentionItem[] = [];
    const pending = this.s.pendingInterpretations;
    if (pending.length) {
      const first = pending[0]!;
      items.push({
        id: "att-confirmar",
        kind: "por_confirmar",
        group: "confirmar",
        title: pending.length === 1 ? "1 registro por confirmar" : `${pending.length} registros por confirmar`,
        description: describePending(first.proposal),
        chip: `${pending.length} por confirmar`,
        link: { to: "/" },
      });
    }
    for (const m of this.materialsOverview().materials) {
      const c = m.computation;
      const totals = this.materialTotals(m.id);
      if (!c || c.status === "dentro" || this.isReviewed(m.id, totals.orderedMilli)) continue;
      const link = { to: "/materiales/$materialId" as const, params: { materialId: m.id } };
      const qty = `${formatNumber(m.ordered)} de ${formatNumber(c.expected)} ${m.unit}`;
      if (c.status === "supera")
        items.push({ id: `att-sup-${m.id}`, kind: "computo_supera", group: "computo", title: `${m.name} supera el cómputo`, description: `${qty} pedidas (${c.percent}%) · conviene revisar`, chip: "Supera el cómputo", link });
      else if (c.status === "cerca")
        items.push({ id: `att-cer-${m.id}`, kind: "computo_cerca", group: "computo", title: `${m.name} cerca del cómputo`, description: `${qty} (${c.percent}%)`, link });
      else items.push({ id: `att-alc-${m.id}`, kind: "computo_alcanzado", group: "computo", title: `${m.name} alcanzó el cómputo`, description: qty, link });
    }
    for (const o of this.s.orders) {
      const summary = this.toOrderSummary(o);
      const link = { to: "/pedidos/$orderId" as const, params: { orderId: o.id } };
      if (summary.delivery.status === "parcial")
        items.push({ id: `att-par-${o.id}`, kind: "entrega_parcial", group: "entregas", title: `Pedido ${summary.number} con entrega parcial`, description: `${summary.delivery.pendingLabel ?? "Faltan materiales"} · ${summary.supplier.name}`, chip: "Entrega parcial", link });
      if (summary.delivery.status === "entregado" && summary.payment.status === "sin_pagos")
        items.push({ id: `att-sp-${o.id}`, kind: "entregado_sin_pagos", group: "pagos", title: `Pedido ${summary.number} entregado, sin pagos`, description: `${summary.total !== null ? formatMoney(summary.total) : "Importe a confirmar"} · ${summary.supplier.name}`, chip: "Entregado sin pagos", link });
    }
    for (const s of this.s.suppliers) {
      const sum = this.toSupplierSummary(s);
      if (sum.unallocatedPaid > 0)
        items.push({ id: `att-imp-${s.id}`, kind: "pago_sin_imputar", group: "pagos", title: `${formatMoney(sum.unallocatedPaid)} sin imputar`, description: `${s.name} · saldo ${formatMoney(sum.balance)}`, chip: "Pago sin imputar", link: { to: "/proveedores/$supplierId", params: { supplierId: s.id } } });
    }
    for (const o of this.s.orders.filter((x) => !this.hasOrderProof(x)))
      items.push({ id: `att-doc-${o.id}`, kind: "sin_comprobante", group: "documentos", title: `Pedido ${this.orderNumber(o)} sin comprobante`, description: this.supplierName(o.supplierId), link: { to: "/pedidos/$orderId", params: { orderId: o.id } } });
    const priority: AttentionItem["kind"][] = ["por_confirmar", "entrega_parcial", "entregado_sin_pagos", "pago_sin_imputar", "computo_supera", "sin_comprobante", "computo_cerca", "computo_alcanzado"];
    return items.sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
  }

  dashboard(audit: AuditRow[]): DashboardSummary {
    const sup = this.suppliersOverview();
    return {
      totalBalance: sup.totalBalance,
      suppliersWithBalance: sup.suppliers.filter((s) => s.balance > 0).length,
      unallocatedTotal: sup.unallocatedTotal,
      attention: this.attentionItems(),
      recentActivity: audit.slice(0, 3).map((a) => this.toActivity(a)),
      computation: this.computationInfo(),
      hasData: this.s.orders.length > 0 || this.s.payments.length > 0,
    };
  }

  // ------------------------------------------------------------ activity

  toActivity(row: AuditRow): ActivityEvent {
    const meta = row.metadata ? (JSON.parse(row.metadata) as { tags?: StatusTag[] }) : {};
    return {
      id: row.id,
      kind: activityKindOf(row.action),
      at: localDateTime(row.at, this.tz),
      title: activityTitle(row.action),
      description: row.summary,
      shortDescription: row.shortSummary ?? undefined,
      supplierId: row.supplierId ?? undefined,
      orderId: row.orderId ?? undefined,
      changes: row.changes ? (JSON.parse(row.changes) as ActivityChange[]) : undefined,
      reason: row.reason ?? undefined,
      tags: meta.tags,
    };
  }
}

const ACTIVITY_KIND: Record<string, ActivityKind> = {
  "order.created": "pedido_registrado",
  "delivery.created": "entrega_registrada",
  "payment.created": "pago_registrado",
  "payment.allocated": "pago_imputado",
  "document.attached": "documento_agregado",
  "computation.item_created": "computo_actualizado",
  "computation.item_revised": "computo_actualizado",
  "computation.imported": "computo_actualizado",
  "computation.reviewed": "computo_actualizado",
};

const ACTIVITY_TITLE: Record<string, string> = {
  "order.created": "Pedido registrado",
  "order.corrected": "Registro corregido",
  "order.voided": "Pedido deshecho",
  "delivery.created": "Entrega registrada",
  "delivery.voided": "Entrega deshecha",
  "payment.created": "Pago registrado",
  "payment.allocated": "Pago imputado",
  "payment.voided": "Pago deshecho",
  "payment.allocation_voided": "Imputación deshecha",
  "document.attached": "Documento agregado",
  "computation.item_created": "Cómputo actualizado",
  "computation.item_revised": "Cómputo actualizado",
  "computation.imported": "Cómputo actualizado",
  "computation.reviewed": "Cómputo revisado",
  "supplier.created": "Proveedor agregado",
  "material.created": "Material agregado al catálogo",
  "material.alias_added": "Material vinculado",
};

export function activityKindOf(action: string): ActivityKind {
  return ACTIVITY_KIND[action] ?? "registro_corregido";
}

export function activityTitle(action: string): string {
  return ACTIVITY_TITLE[action] ?? "Registro corregido";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => w.length > 2 && !["del", "las", "los"].includes(w.toLowerCase()));
  return (words.length ? words : name.split(/\s+/))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function describePending(proposalJson: string): string {
  try {
    const p = JSON.parse(proposalJson) as { kind?: string; supplierName?: string; orderNumber?: string; document?: { fileName?: string } };
    const what = p.kind === "delivery" ? "Entrega" : p.kind === "payment" ? "Pago" : "Pedido";
    return `${what}${p.supplierName ? ` de ${p.supplierName}` : ""}${p.document?.fileName ? ` · ${p.document.fileName}` : ""}`;
  } catch {
    return "Revisa el asistente";
  }
}
