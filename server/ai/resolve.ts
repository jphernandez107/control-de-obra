import type { MatchOption } from "../../src/domain/assistant";
import type { Ledger } from "../domain/derive";
import { findOrdersByReference, matchMaterial, matchSupplier, rankOrders, type MaterialCandidate, type OrderMatchCriteria, type SupplierCandidate } from "../domain/matching";
import type { Order } from "../repositories/snapshot";

// Resolves free-text mentions (from a provider, a tool call or an edited
// proposal) to records, using the deterministic matchers. Weak matches come
// back with candidates; nothing is created or selected silently.

export function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((w, i) => (i > 0 && ["de", "del", "la", "las", "los", "y", "el"].includes(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function supplierCandidates(ledger: Ledger): (SupplierCandidate & { category: string })[] {
  return ledger.s.suppliers.map((s) => ({ id: s.id, name: s.name, aliases: safeJsonArray(s.aliases), category: s.category }));
}

export function materialCandidates(ledger: Ledger): MaterialCandidate[] {
  return ledger.s.materials.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, shortName: m.shortName, aliases: ledger.materialAliases(m.id), baseUnit: m.baseUnit }));
}

export interface SupplierResolution {
  status: "matched" | "suggested" | "new";
  id: string | null;
  /** Catalog name when matched/suggested, the mention in title case when new. */
  name: string;
  candidates: MatchOption[];
}

export function resolveSupplierMention(ledger: Ledger, mention: string | null): SupplierResolution {
  if (!mention) return { status: "new", id: null, name: "", candidates: [] };
  const result = matchSupplier(mention, supplierCandidates(ledger));
  return {
    status: result.status,
    id: result.status === "new" ? null : result.best!.id,
    name: result.status === "new" ? titleCase(mention) : result.best!.name,
    candidates: result.candidates.map((c) => ({ id: c.item.id, name: c.item.name })),
  };
}

export type Resolved<T> = { status: "ok"; value: T } | { status: "not_found" | "ambiguous"; candidates: MatchOption[] };

/** For read-only use: a single clear supplier, else candidates. */
export function resolveSupplier(ledger: Ledger, mention: string): Resolved<string> {
  const result = matchSupplier(mention, supplierCandidates(ledger));
  const candidates = result.candidates.map((c) => ({ id: c.item.id, name: c.item.name }));
  if (result.status === "new") return { status: "not_found", candidates };
  const [first, second] = result.candidates;
  if (result.status === "suggested" && second && first && first.score - second.score < 0.1) return { status: "ambiguous", candidates };
  return { status: "ok", value: result.best!.id };
}

export function resolveMaterial(ledger: Ledger, mention: string): Resolved<string> {
  const result = matchMaterial(mention, materialCandidates(ledger));
  const candidates = result.candidates.map((c) => ({ id: c.item.id, name: c.item.name, unit: ledger.unitLabel(c.item.baseUnit) }));
  if (result.status === "new") return { status: "not_found", candidates };
  if (result.status === "suggested") return { status: "ambiguous", candidates };
  return { status: "ok", value: result.best!.id };
}

function orderOption(ledger: Ledger, o: Order): MatchOption {
  return { id: o.id, name: `Pedido ${ledger.orderNumber(o)} · ${ledger.supplierName(o.supplierId)}` };
}

/** Explicit references ("pedido 38") are looked up deterministically; several hits are ambiguous. */
export function resolveOrderReference(ledger: Ledger, reference: string, supplierId?: string | null): Resolved<Order> {
  const found = findOrdersByReference(reference, ledger.s.orders, supplierId ?? undefined);
  if (found.length === 1) return { status: "ok", value: found[0]! };
  return { status: found.length ? "ambiguous" : "not_found", candidates: found.map((o) => orderOption(ledger, o)) };
}

/**
 * Candidate orders when there is no explicit reference (documents, vague
 * messages): ranked by supplier, reference, date proximity and item overlap.
 * Only a clear winner is returned as `ok`; close scores are ambiguous.
 */
export function rankOrderCandidates(ledger: Ledger, criteria: OrderMatchCriteria, pool: Order[] = ledger.s.orders): Resolved<Order> & { ranked: Order[] } {
  const rankable = pool.map((o) => ({
    ...o,
    materialIds: ledger.items(o.id).map((i) => i.materialId),
    openMaterialIds: ledger
      .items(o.id)
      .filter((i) => ledger.remainingMilli(i) > 0)
      .map((i) => i.materialId),
    remainingByMaterial: ledger.items(o.id).reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.materialId]: (acc[i.materialId] ?? 0) + ledger.remainingMilli(i) }), {}),
  }));
  const result = rankOrders(criteria, rankable);
  const ranked = result.candidates.map((c) => ledger.order(c.item.id)!);
  const candidates = ranked.slice(0, 4).map((o) => orderOption(ledger, o));
  if (result.status === "new") return { status: "not_found", candidates, ranked };
  if (result.status === "suggested" && result.candidates.length > 1 && result.candidates[0]!.score - result.candidates[1]!.score < 0.15) return { status: "ambiguous", candidates, ranked };
  return { status: "ok", value: ledger.order(result.best!.id)!, ranked };
}
