import { and, eq, isNull } from "drizzle-orm";
import type { AppDb } from "../db/client";
import * as s from "../db/schema";

export type Project = typeof s.projects.$inferSelect;
export type User = typeof s.users.$inferSelect;
export type Unit = typeof s.units.$inferSelect;
export type Supplier = typeof s.suppliers.$inferSelect;
export type Material = typeof s.materials.$inferSelect;
export type MaterialAlias = typeof s.materialAliases.$inferSelect;
export type UnitConversion = typeof s.unitConversions.$inferSelect;
export type Order = typeof s.orders.$inferSelect;
export type OrderItem = typeof s.orderItems.$inferSelect;
export type Delivery = typeof s.deliveries.$inferSelect;
export type DeliveryItem = typeof s.deliveryItems.$inferSelect;
export type Payment = typeof s.payments.$inferSelect;
export type PaymentAllocation = typeof s.paymentAllocations.$inferSelect;
export type DocumentRow = typeof s.documents.$inferSelect;
export type DocumentLink = typeof s.documentLinks.$inferSelect;
export type Computation = typeof s.computations.$inferSelect;
export type ComputationItem = typeof s.computationItems.$inferSelect;
export type ComputationRevision = typeof s.computationRevisions.$inferSelect;
export type AuditRow = typeof s.auditLog.$inferSelect;

/**
 * Everything the derivations need for one project, active (non-voided) rows
 * only. A construction project has hundreds to a few thousand rows, so
 * loading the working set and deriving in memory keeps the business rules in
 * plain, testable functions.
 */
export interface Snapshot {
  project: Project;
  today: string;
  users: User[];
  units: Unit[];
  suppliers: Supplier[];
  materials: Material[];
  aliases: MaterialAlias[];
  conversions: UnitConversion[];
  orders: Order[];
  orderItems: OrderItem[];
  deliveries: Delivery[];
  deliveryItems: DeliveryItem[];
  payments: Payment[];
  allocations: PaymentAllocation[];
  documents: DocumentRow[];
  documentLinks: DocumentLink[];
  computation: Computation | null;
  computationItems: ComputationItem[];
  computationRevisions: ComputationRevision[];
  pendingInterpretations: { id: string; intent: string; proposal: string; createdAt: string }[];
}

export async function loadSnapshot(db: AppDb, projectId: string, today: string): Promise<Snapshot> {
  const [project] = await db.select().from(s.projects).where(eq(s.projects.id, projectId));
  if (!project) throw new Error(`Proyecto ${projectId} no encontrado`);
  const [users, units, suppliers, materials, aliases, conversions, orders, deliveries, payments, documents, computations, pending] = await Promise.all([
    db.select().from(s.users).where(eq(s.users.projectId, projectId)),
    db.select().from(s.units),
    db.select().from(s.suppliers).where(eq(s.suppliers.projectId, projectId)),
    db.select().from(s.materials).where(eq(s.materials.projectId, projectId)),
    db.select().from(s.materialAliases).where(eq(s.materialAliases.projectId, projectId)),
    db.select().from(s.unitConversions),
    db.select().from(s.orders).where(and(eq(s.orders.projectId, projectId), isNull(s.orders.voidedAt))),
    db.select().from(s.deliveries).where(and(eq(s.deliveries.projectId, projectId), isNull(s.deliveries.voidedAt))),
    db.select().from(s.payments).where(and(eq(s.payments.projectId, projectId), isNull(s.payments.voidedAt))),
    db.select().from(s.documents).where(eq(s.documents.projectId, projectId)),
    db.select().from(s.computations).where(eq(s.computations.projectId, projectId)),
    db
      .select({ id: s.aiInterpretations.id, intent: s.aiInterpretations.intent, proposal: s.aiInterpretations.proposal, createdAt: s.aiInterpretations.createdAt })
      .from(s.aiInterpretations)
      .where(and(eq(s.aiInterpretations.projectId, projectId), eq(s.aiInterpretations.status, "pending"))),
  ]);
  const orderIds = orders.map((o) => o.id);
  const deliveryIds = new Set(deliveries.map((d) => d.id));
  const paymentIds = new Set(payments.map((p) => p.id));
  const computation = computations[0] ?? null;
  // Child rows are fetched by joining on their parent's project instead of
  // `IN (...)` lists, which would hit D1's bound-parameter limit.
  const [orderItems, deliveryItems, allocations, documentLinks, computationItems, computationRevisions] = await Promise.all([
    db
      .select({ row: s.orderItems })
      .from(s.orderItems)
      .innerJoin(s.orders, eq(s.orderItems.orderId, s.orders.id))
      .where(and(eq(s.orders.projectId, projectId), isNull(s.orders.voidedAt)))
      .then((r) => r.map((x) => x.row)),
    db
      .select({ row: s.deliveryItems })
      .from(s.deliveryItems)
      .innerJoin(s.deliveries, eq(s.deliveryItems.deliveryId, s.deliveries.id))
      .where(and(eq(s.deliveries.projectId, projectId), isNull(s.deliveries.voidedAt)))
      .then((r) => r.map((x) => x.row)),
    db
      .select({ row: s.paymentAllocations })
      .from(s.paymentAllocations)
      .innerJoin(s.payments, eq(s.paymentAllocations.paymentId, s.payments.id))
      .where(and(eq(s.payments.projectId, projectId), isNull(s.payments.voidedAt), isNull(s.paymentAllocations.voidedAt)))
      .then((r) => r.map((x) => x.row)),
    db
      .select({ row: s.documentLinks })
      .from(s.documentLinks)
      .innerJoin(s.documents, eq(s.documentLinks.documentId, s.documents.id))
      .where(and(eq(s.documents.projectId, projectId), isNull(s.documentLinks.voidedAt)))
      .then((r) => r.map((x) => x.row)),
    computation ? db.select().from(s.computationItems).where(eq(s.computationItems.computationId, computation.id)) : Promise.resolve([]),
    computation ? db.select().from(s.computationRevisions).where(eq(s.computationRevisions.computationId, computation.id)) : Promise.resolve([]),
  ]);
  const activeOrders = new Set(orderIds);
  return {
    project,
    today,
    users,
    units,
    suppliers,
    materials,
    aliases,
    conversions,
    orders,
    orderItems,
    deliveries,
    deliveryItems,
    payments,
    // An allocation to a voided order no longer counts (voiding is blocked while allocations exist).
    allocations: allocations.filter((a) => activeOrders.has(a.orderId)),
    documents,
    documentLinks: documentLinks.filter(
      (l) => (!l.orderId || activeOrders.has(l.orderId)) && (!l.deliveryId || deliveryIds.has(l.deliveryId)) && (!l.paymentId || paymentIds.has(l.paymentId)),
    ),
    computation,
    computationItems,
    computationRevisions,
    pendingInterpretations: pending,
  };
}
