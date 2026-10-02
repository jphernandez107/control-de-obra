import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { Ledger } from "../domain/derive";
import { DomainError } from "../domain/errors";
import { normalizeText } from "../domain/text";
import { addDays, localDate } from "../domain/time";
import { loadSnapshot } from "../repositories/snapshot";
import type { ActivityFilters, ActivityKind, ActivityPage } from "../../src/domain/types";

// Read side. Every figure is derived from persisted records at request time.

export interface QueryContext {
  db: AppDb;
  projectId: string;
  now: () => Date;
}

export async function ledgerFor(ctx: QueryContext): Promise<Ledger> {
  const snapshot = await loadSnapshot(ctx.db, ctx.projectId, "");
  const ledger = new Ledger(snapshot);
  snapshot.today = localDate(ctx.now(), snapshot.project.timezone);
  return ledger;
}

export async function projectToday(ctx: QueryContext): Promise<string> {
  const [project] = await ctx.db.select({ tz: t.projects.timezone }).from(t.projects).where(eq(t.projects.id, ctx.projectId));
  return localDate(ctx.now(), project?.tz ?? "America/Argentina/Cordoba");
}

async function auditRows(ctx: QueryContext, opts: { from?: string; to?: string; limit?: number } = {}) {
  const conditions = [eq(t.auditLog.projectId, ctx.projectId)];
  // Day bounds are widened by one day to cover the timezone offset; exact filtering happens on local dates.
  if (opts.from) conditions.push(gte(t.auditLog.at, `${addDays(opts.from, -1)}T00:00:00.000Z`));
  if (opts.to) conditions.push(lte(t.auditLog.at, `${addDays(opts.to, 1)}T23:59:59.999Z`));
  const q = ctx.db.select().from(t.auditLog).where(and(...conditions)).orderBy(desc(t.auditLog.at));
  return opts.limit ? q.limit(opts.limit) : q;
}

export async function ordersOverview(ctx: QueryContext) {
  return (await ledgerFor(ctx)).ordersOverview();
}

export async function orderDetail(ctx: QueryContext, orderId: string) {
  const ledger = await ledgerFor(ctx);
  const order = ledger.order(orderId);
  if (!order) throw new DomainError("not_found", "Pedido no encontrado");
  const audit = await ctx.db.select().from(t.auditLog).where(eq(t.auditLog.orderId, orderId)).orderBy(desc(t.auditLog.at));
  return ledger.toOrderDetail(order, audit);
}

export async function suppliersOverview(ctx: QueryContext) {
  return (await ledgerFor(ctx)).suppliersOverview();
}

export async function supplierDetail(ctx: QueryContext, supplierId: string) {
  const ledger = await ledgerFor(ctx);
  const supplier = ledger.supplier(supplierId);
  if (!supplier) throw new DomainError("not_found", "Proveedor no encontrado");
  return ledger.toSupplierDetail(supplier);
}

export async function supplierOptions(ctx: QueryContext) {
  const ledger = await ledgerFor(ctx);
  return ledger.s.suppliers
    .map((s) => {
      const sum = ledger.toSupplierSummary(s);
      return { id: s.id, name: s.name, initials: sum.initials, category: s.category, contactName: sum.contactName, phone: sum.phone };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export async function materialsOverview(ctx: QueryContext) {
  return (await ledgerFor(ctx)).materialsOverview();
}

export async function materialDetail(ctx: QueryContext, materialId: string) {
  const ledger = await ledgerFor(ctx);
  const material = ledger.material(materialId);
  if (!material) throw new DomainError("not_found", "Material no encontrado");
  return ledger.toMaterialDetail(material);
}

/** Full catalog for pickers (also materials without orders). */
export async function materialOptions(ctx: QueryContext) {
  const ledger = await ledgerFor(ctx);
  return ledger.s.materials
    .filter((m) => m.active)
    .map((m) => ({ id: m.id, name: m.name, unit: ledger.unitLabel(m.baseUnit), unitCode: m.baseUnit, category: m.category, aliases: ledger.materialAliases(m.id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export async function unitOptions(ctx: QueryContext) {
  return ctx.db.select().from(t.units);
}

export async function dashboard(ctx: QueryContext) {
  const ledger = await ledgerFor(ctx);
  const audit = await auditRows(ctx, { limit: 20 });
  return ledger.dashboard(audit);
}

const EMPTY_COUNTS: Record<ActivityKind, number> = {
  pedido_registrado: 0,
  documento_agregado: 0,
  entrega_registrada: 0,
  pago_registrado: 0,
  pago_imputado: 0,
  registro_corregido: 0,
  computo_actualizado: 0,
};

export async function activity(ctx: QueryContext, filters: ActivityFilters): Promise<ActivityPage> {
  const ledger = await ledgerFor(ctx);
  const rows = await auditRows(ctx, { from: filters.from, to: filters.to });
  const q = filters.search ? normalizeText(filters.search) : "";
  const inRange = rows
    .map((r) => ledger.toActivity(r))
    .filter((e) => {
      const day = e.at.slice(0, 10);
      if (filters.from && day < filters.from) return false;
      if (filters.to && day > filters.to) return false;
      if (filters.supplierId && e.supplierId !== filters.supplierId) return false;
      if (q && !normalizeText(`${e.title} ${e.description}`).includes(q)) return false;
      return true;
    });
  const countsByKind = { ...EMPTY_COUNTS };
  for (const e of inRange) countsByKind[e.kind] += 1;
  const events = inRange.filter((e) => !filters.kinds?.length || filters.kinds.includes(e.kind));
  return { events, countsByKind, total: events.length };
}
