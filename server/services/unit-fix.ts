import { formatNumber } from "../../src/domain/format";
import { canonicalMaterialName } from "../domain/matching";
import { fromMilli } from "../domain/quantity";
import { normalizeReference, normalizeText } from "../domain/text";
import { parsePurchaseFormat, type PurchaseFormat } from "../domain/units";

// Targeted correction for order lines imported before purchase units
// existed: "HIERRO DIAM.12 X BARRA 12 MT · 172" stored as 172 m instead of
// 172 bars of 12 m. A line is corrected only with explicit evidence — its
// description (or its material's name/alias) prints a piece format and the
// stored unit is that piece's size unit — and never when deliveries were
// recorded against it. Quantities and prices stay as they are (they already
// counted bars). Pure planning: it returns SQL for a reviewed, idempotent run.

export interface FixLineRow {
  item_id: string;
  order_id: string;
  project_id: string;
  supplier_id: string;
  supplier_name: string;
  internal_number: number;
  reference: string | null;
  description: string;
  quantity_milli: number;
  unit: string;
  unit_size_milli: number | null;
  material_id: string;
}

export interface FixData {
  lines: FixLineRow[];
  materials: { id: string; project_id: string; name: string; normalized_name: string; base_unit: string }[];
  aliases: { material_id: string; project_id: string; alias: string; normalized_alias: string }[];
  conversions: { material_id: string | null; from_unit: string; to_unit: string }[];
  /** Non-voided delivery lines. */
  deliveryItems: { material_id: string; order_item_id: string | null; unit: string }[];
  /** Computation lines with an acknowledged "reviewed" quantity (stored in the material's base unit). */
  reviewedComputation: { material_id: string }[];
}

export interface UnitFixPlan {
  lines: { itemId: string; order: string; description: string; before: string; after: string }[];
  materials: { materialId: string; before: string; after: string; notes: string[] }[];
  skipped: { itemId: string; order: string; description: string; reason: string }[];
  statements: string[];
}

const UNIT_LABEL: Record<string, string> = { barra: "barras", bolsa: "bolsas", m: "m", kg: "kg" };
const label = (milli: number, unit: string) => `${formatNumber(fromMilli(milli))} ${UNIT_LABEL[unit] ?? unit}`;
const q = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);

function orderLabel(l: FixLineRow): string {
  return l.reference ?? `#${l.internal_number}`;
}

function matchesOrder(l: FixLineRow, wanted: string): boolean {
  const n = normalizeReference(wanted.replace(/^#/, ""));
  if (l.reference) return normalizeReference(l.reference) === n;
  return String(l.internal_number) === n;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function planUnitFix(data: FixData, options: { order?: string; now: string; newId: () => string }): UnitFixPlan {
  const plan: UnitFixPlan = { lines: [], materials: [], skipped: [], statements: [] };
  const materialById = new Map(data.materials.map((m) => [m.id, m]));
  const formatOf = (l: FixLineRow): PurchaseFormat | null => {
    const material = materialById.get(l.material_id);
    const names = [l.description, material?.name ?? "", ...data.aliases.filter((a) => a.material_id === l.material_id).map((a) => a.alias)];
    for (const n of names) {
      const f = n ? parsePurchaseFormat(n) : null;
      if (f) return f;
    }
    return null;
  };
  const fixed: (FixLineRow & { format: PurchaseFormat })[] = [];
  for (const l of data.lines) {
    if (l.unit_size_milli !== null) continue;
    if (options.order && !matchesOrder(l, options.order)) continue;
    const format = formatOf(l);
    if (!format) continue;
    const base = { itemId: l.item_id, order: orderLabel(l), description: l.description };
    if (l.unit !== format.pieceUnit && l.unit !== format.size.unit) {
      plan.skipped.push({ ...base, reason: `está en ${UNIT_LABEL[l.unit] ?? l.unit}: no es la medida de la pieza; revísalo a mano` });
      continue;
    }
    if (l.unit === format.size.unit && data.deliveryItems.some((d) => d.order_item_id === l.item_id)) {
      plan.skipped.push({ ...base, reason: "tiene entregas registradas en esa unidad; corrígelo a mano" });
      continue;
    }
    fixed.push({ ...l, format });
    plan.lines.push({
      ...base,
      before: label(l.quantity_milli, l.unit),
      after: `${label(l.quantity_milli, format.pieceUnit)} de ${label(format.size.milli, format.size.unit)}`,
    });
    plan.statements.push(
      `UPDATE order_items SET unit = ${q(format.pieceUnit)}, unit_size_milli = ${format.size.milli}, unit_size_unit = ${q(format.size.unit)} WHERE id = ${q(l.item_id)} AND unit = ${q(l.unit)} AND unit_size_milli IS NULL;`,
    );
  }

  // Materials of the corrected lines: count in pieces, learn the conversion, use the canonical name.
  const fixedIds = new Set(fixed.map((l) => l.item_id));
  for (const materialId of new Set(fixed.map((l) => l.material_id))) {
    const m = materialById.get(materialId);
    if (!m) continue;
    const format = fixed.find((l) => l.material_id === materialId)!.format;
    const notes: string[] = [];
    let baseUnit = m.base_unit;
    if (m.base_unit === format.size.unit) {
      const otherLines = data.lines.filter((l) => l.material_id === materialId && !fixedIds.has(l.item_id) && l.unit === m.base_unit);
      const measuredDeliveries = data.deliveryItems.some((d) => d.material_id === materialId && d.unit === m.base_unit && (!d.order_item_id || !fixedIds.has(d.order_item_id)));
      if (otherLines.length || measuredDeliveries) notes.push(`queda en ${m.base_unit}: tiene otros registros en esa unidad`);
      else baseUnit = format.pieceUnit;
    }
    const hasConversion = data.conversions.some((c) => c.material_id === materialId && ((c.from_unit === format.pieceUnit && c.to_unit === format.size.unit) || (c.from_unit === format.size.unit && c.to_unit === format.pieceUnit)));
    if (!hasConversion) {
      const d = gcd(format.size.milli, 1000);
      plan.statements.push(
        `INSERT INTO unit_conversions (id, material_id, from_unit, to_unit, factor_num, factor_den) SELECT ${q(options.newId())}, ${q(materialId)}, ${q(format.pieceUnit)}, ${q(format.size.unit)}, ${format.size.milli / d}, ${1000 / d} WHERE NOT EXISTS (SELECT 1 FROM unit_conversions WHERE material_id = ${q(materialId)} AND from_unit = ${q(format.pieceUnit)} AND to_unit = ${q(format.size.unit)});`,
      );
      notes.push(`1 ${format.pieceUnit} = ${label(format.size.milli, format.size.unit)}`);
    }
    const canonical = canonicalMaterialName(m.name);
    let name = m.name;
    const clash = data.materials.find((x) => x.id !== m.id && x.project_id === m.project_id && normalizeText(x.name) === normalizeText(canonical.name));
    if (canonical.name !== m.name && canonical.category === "Hierros") {
      if (clash) notes.push(`ya existe «${clash.name}»: no se renombra; unir a mano si es el mismo material`);
      else name = canonical.name;
    }
    const set: string[] = [];
    if (baseUnit !== m.base_unit) set.push(`base_unit = ${q(baseUnit)}`);
    if (name !== m.name) set.push(`name = ${q(name)}`, `normalized_name = ${q(normalizeText(name))}`, `short_name = ${q(canonical.shortName)}`, `category = 'Hierros'`);
    if (set.length) {
      plan.statements.push(`UPDATE materials SET ${set.join(", ")}, updated_at = ${q(options.now)} WHERE id = ${q(materialId)} AND base_unit = ${q(m.base_unit)} AND name = ${q(m.name)};`);
      if (baseUnit !== m.base_unit && data.reviewedComputation.some((c) => c.material_id === materialId)) {
        // "Reviewed at N" was stored in the old unit: the alert shows again until it is reviewed in bars.
        plan.statements.push(`UPDATE computation_items SET reviewed_ordered_milli = NULL WHERE material_id = ${q(materialId)};`);
        notes.push("el aviso de cómputo revisado vuelve a mostrarse");
      }
    }
    // The old name stays recognizable as an alias ("HIERRO DIAM.12 X BARRA 12 MT").
    if (name !== m.name) {
      const normalized = normalizeText(m.name);
      plan.statements.push(
        `INSERT INTO material_aliases (id, project_id, material_id, alias, normalized_alias, source, created_at) SELECT ${q(options.newId())}, ${q(m.project_id)}, ${q(materialId)}, ${q(m.name)}, ${q(normalized)}, 'manual', ${q(options.now)} WHERE NOT EXISTS (SELECT 1 FROM material_aliases WHERE project_id = ${q(m.project_id)} AND normalized_alias = ${q(normalized)});`,
      );
    }
    plan.materials.push({ materialId, before: `${m.name} (${m.base_unit})`, after: `${name} (${baseUnit})`, notes });
  }

  // One audit entry per corrected order, as the app writes for any correction.
  for (const orderId of new Set(fixed.map((l) => l.order_id))) {
    const lines = fixed.filter((l) => l.order_id === orderId);
    const first = lines[0]!;
    const changes = lines.map((l) => ({ label: `Unidad ${l.description}`, before: label(l.quantity_milli, l.unit), after: `${label(l.quantity_milli, l.format.pieceUnit)} de ${label(l.format.size.milli, l.format.size.unit)}` }));
    plan.statements.push(
      `INSERT INTO audit_log (id, project_id, at, actor_user_id, source, action, entity_type, entity_id, summary, short_summary, changes, reason, metadata, supplier_id, order_id, ai_interpretation_id) VALUES (${[
        q(options.newId()),
        q(first.project_id),
        q(options.now),
        "NULL",
        "'system'",
        "'order.corrected'",
        "'order'",
        q(orderId),
        q(`Pedido ${orderLabel(first)} · ${first.supplier_name} · unidad de compra corregida`),
        q(`Pedido ${orderLabel(first)} · unidad corregida`),
        q(JSON.stringify(changes)),
        q("La cantidad contaba piezas (barras), no metros: se guarda la medida de cada pieza."),
        "NULL",
        q(first.supplier_id),
        q(orderId),
        "NULL",
      ].join(", ")});`,
    );
  }
  return plan;
}

/** Read-only queries that collect `FixData` (run against local SQLite or D1). */
export const FIX_QUERIES: Record<keyof FixData, string> = {
  lines: `SELECT oi.id AS item_id, oi.order_id, o.project_id, o.supplier_id, s.name AS supplier_name, o.internal_number, o.reference, oi.description, oi.quantity_milli, oi.unit, oi.unit_size_milli, oi.material_id FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN suppliers s ON s.id = o.supplier_id WHERE o.voided_at IS NULL ORDER BY o.internal_number, oi.position`,
  materials: `SELECT id, project_id, name, normalized_name, base_unit FROM materials`,
  aliases: `SELECT material_id, project_id, alias, normalized_alias FROM material_aliases`,
  conversions: `SELECT material_id, from_unit, to_unit FROM unit_conversions`,
  deliveryItems: `SELECT di.material_id, di.order_item_id, di.unit FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id WHERE d.voided_at IS NULL`,
  reviewedComputation: `SELECT material_id FROM computation_items WHERE reviewed_ordered_milli IS NOT NULL`,
};
