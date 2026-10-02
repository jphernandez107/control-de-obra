import { normalizeReference, normalizeText, tokens } from "./text";

// Deterministic matching of free text ("hierro del 12", "la ladrillera",
// "pedido 38") against catalog records. The AI provider only extracts
// mentions; deciding which record they refer to is application logic, so a
// weak match is never silently accepted.

export type MatchStatus = "matched" | "suggested" | "new";

export interface MatchCandidate<T> {
  item: T;
  score: number;
}

export interface MatchResult<T> {
  status: MatchStatus;
  best?: T;
  score: number;
  candidates: MatchCandidate<T>[];
}

export const STRONG_MATCH = 0.85;
export const WEAK_MATCH = 0.5;

function decide<T>(scored: MatchCandidate<T>[]): MatchResult<T> {
  const sorted = scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (!top || top.score < WEAK_MATCH) return { status: "new", score: top?.score ?? 0, candidates: sorted.slice(0, 3) };
  const second = sorted[1];
  const ambiguous = second !== undefined && top.score - second.score < 0.1 && top.score < 0.99;
  const status: MatchStatus = top.score >= STRONG_MATCH && !ambiguous ? "matched" : "suggested";
  return { status, best: top.item, score: top.score, candidates: sorted.slice(0, 3) };
}

function tokenScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  if (!shared) return 0;
  // Numbers are identifying (Ø12 vs Ø10, 12x18x33): a mismatch kills the match.
  const numsA = a.filter((t) => /\d/.test(t));
  const numsB = b.filter((t) => /\d/.test(t));
  if (numsA.length && numsB.length && !numsA.some((n) => numsB.includes(n))) return 0;
  const precision = shared / a.length;
  const recall = shared / b.length;
  return (2 * precision * recall) / (precision + recall);
}

// ---------------------------------------------------------------- suppliers

export interface SupplierCandidate {
  id: string;
  name: string;
  aliases: string[];
}

const SUPPLIER_NOISE = new Set(["proveedor", "corralon", "la", "el", "cuenta", "corriente"]);

export function matchSupplier<T extends SupplierCandidate>(mention: string, suppliers: T[]): MatchResult<T> {
  const m = normalizeText(mention);
  if (!m) return { status: "new", score: 0, candidates: [] };
  const mTokens = tokens(m);
  const scored = suppliers.map((s) => {
    const names = [s.name, ...s.aliases];
    let score = 0;
    for (const name of names) {
      const n = normalizeText(name);
      if (n === m) score = Math.max(score, 1);
      else if (m.includes(n) || n.includes(m)) score = Math.max(score, 0.9);
      else {
        const nTokens = tokens(n);
        const distinctive = nTokens.filter((t) => !SUPPLIER_NOISE.has(t));
        const hits = distinctive.filter((t) => mTokens.some((x) => x === t || (x.length >= 5 && t.startsWith(x)) || (t.length >= 5 && x.startsWith(t))));
        if (hits.length) score = Math.max(score, Math.min(0.88, 0.6 + 0.28 * (hits.length / distinctive.length)));
      }
    }
    return { item: s, score };
  });
  return decide(scored);
}

// ---------------------------------------------------------------- materials

export interface MaterialCandidate {
  id: string;
  name: string;
  shortName: string;
  aliases: string[];
  baseUnit: string;
}

const STEEL_WORDS = /\b(barras?|hierros?|acero|aceros|o\d|diametro|fi)\b/;
const DIAMETERS = ["4.2", "4,2", "6", "8", "10", "12", "16", "20", "25"];

/** "hierro del 12", "barras de 10", "acero 12 mm", "Ø12" → "12". */
export function extractDiameter(mention: string): string | null {
  const t = normalizeText(mention);
  const direct = /\bo\s?(\d{1,2}(?:[.,]\d)?)\b/.exec(t);
  if (direct) return direct[1]!.replace(",", ".");
  if (!STEEL_WORDS.test(t)) return null;
  const m = /\b(?:del|de|d)?\s*(\d{1,2}(?:[.,]\d)?)\s*(?:mm)?\b/.exec(t.replace(/^\d+\s+(?=barras?)/, ""));
  if (m && DIAMETERS.includes(m[1]!)) return m[1]!.replace(",", ".");
  return null;
}

function materialDiameter(name: string): string | null {
  const m = /\bo\s?(\d{1,2}(?:[.,]\d)?)\b/.exec(normalizeText(name));
  return m ? m[1]!.replace(",", ".") : null;
}

export function matchMaterial<T extends MaterialCandidate>(mention: string, materials: T[]): MatchResult<T> {
  const m = normalizeText(mention);
  if (!m) return { status: "new", score: 0, candidates: [] };
  const diameter = extractDiameter(m);
  const mTokens = tokens(m);
  const scored = materials.map((mat) => {
    const names = [mat.name, mat.shortName, ...mat.aliases];
    let score = 0;
    for (const name of names) {
      const n = normalizeText(name);
      if (!n) continue;
      if (n === m) score = Math.max(score, 1);
      else score = Math.max(score, tokenScore(mTokens, tokens(n)) * 0.92);
    }
    if (diameter) {
      const d = materialDiameter(mat.name);
      if (d === diameter && /acero|hierro|barra/.test(normalizeText(`${mat.name} ${mat.aliases.join(" ")}`))) score = Math.max(score, 0.95);
      else if (d && d !== diameter) score = 0;
    }
    return { item: mat, score };
  });
  return decide(scored);
}

// ---------------------------------------------------------------- orders

export interface OrderCandidate {
  id: string;
  supplierId: string;
  reference: string | null;
  internalNumber: number;
}

/** Orders whose external reference (or internal number) matches "38", "0038", "#38", "A-1043". */
export function findOrdersByReference<T extends OrderCandidate>(ref: string, orders: T[], supplierId?: string): T[] {
  const wanted = normalizeReference(ref);
  if (!wanted) return [];
  const pool = supplierId ? orders.filter((o) => o.supplierId === supplierId) : orders;
  const byReference = pool.filter((o) => o.reference && normalizeReference(o.reference) === wanted);
  if (byReference.length) return byReference;
  // "a1043" may be written as "1043"
  const loose = pool.filter((o) => o.reference && normalizeReference(o.reference).replace(/^[a-z]+/, "") === wanted.replace(/^[a-z]+/, ""));
  if (loose.length) return loose;
  const asNumber = /^\d+$/.test(wanted) ? Number(wanted) : NaN;
  return pool.filter((o) => !o.reference && o.internalNumber === asNumber);
}

/** What is known about the order a delivery/payment/document refers to. */
export interface OrderMatchCriteria {
  reference?: string | null;
  supplierId?: string | null;
  /** Date of the delivery or document (YYYY-MM-DD). */
  date?: string | null;
  /** Materials mentioned, with the quantity that arrived when known (thousandths). */
  materials?: { materialId: string; quantityMilli?: number | null }[];
}

export interface RankableOrder extends OrderCandidate {
  orderDate: string;
  materialIds: string[];
  /** Materials with something still to deliver. */
  openMaterialIds: string[];
  /** Remaining quantity per material (thousandths), for quantity fit. */
  remainingByMaterial?: Record<string, number>;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Ranks orders for a document or a vague message. An explicit reference that
 * matches is decisive ("matched"); otherwise the result is at best
 * "suggested", scored by supplier, item overlap, quantity fit and date
 * proximity, so the caller can flag it or ask when scores are close. A
 * future AI-assisted selector can re-rank `candidates`; it should never
 * bypass them.
 */
export function rankOrders<T extends RankableOrder>(criteria: OrderMatchCriteria, orders: T[]): MatchResult<T> {
  const wantedRef = criteria.reference ? normalizeReference(criteria.reference) : "";
  const wanted = criteria.materials ?? [];
  const scored: MatchCandidate<T>[] = [];
  for (const o of orders) {
    if (criteria.supplierId && o.supplierId !== criteria.supplierId) continue;
    if (wantedRef && o.reference && normalizeReference(o.reference) === wantedRef) {
      scored.push({ item: o, score: 1 });
      continue;
    }
    let score = criteria.supplierId ? 0.2 : 0.1;
    if (wanted.length) {
      const hits = wanted.filter((w) => o.openMaterialIds.includes(w.materialId));
      if (!hits.length) continue;
      score += 0.4 * (hits.length / wanted.length);
      const withQty = wanted.filter((w) => w.quantityMilli);
      if (withQty.length && o.remainingByMaterial) {
        const fit = withQty.reduce((s, w) => {
          const remaining = o.remainingByMaterial![w.materialId] ?? 0;
          return s + (remaining === w.quantityMilli ? 1 : remaining > w.quantityMilli! ? 0.3 : 0);
        }, 0);
        score += 0.3 * (fit / withQty.length);
      }
    } else score += 0.3;
    if (criteria.date) score += 0.1 * Math.max(0, 1 - daysBetween(criteria.date, o.orderDate) / 60);
    scored.push({ item: o, score: Math.min(score, 0.99) });
  }
  const sorted = scored.sort((a, b) => b.score - a.score || a.item.orderDate.localeCompare(b.item.orderDate));
  const top = sorted[0];
  if (!top || top.score < WEAK_MATCH) return { status: "new", score: top?.score ?? 0, candidates: sorted.slice(0, 5) };
  return { status: top.score === 1 ? "matched" : "suggested", best: top.item, score: top.score, candidates: sorted.slice(0, 5) };
}
