import { toMilli } from "./quantity";
import { normalizeText } from "./text";

// Maps unit words people write ("barras", "bolsas", "m3", "metros cúbicos")
// to unit codes from the `units` table, and reads the purchase format a
// supplier prints in an item description ("HIERRO DIAM.12 X BARRA 12 MT").

const WORDS: [RegExp, string][] = [
  [/^(barras?|br)$/, "barra"],
  [/^(bolsas?|bls?)$/, "bolsa"],
  [/^(m3|m³|mts3|metros? cubicos?|metro cubico)$/, "m3"],
  [/^(m2|m²|mts2|metros? cuadrados?)$/, "m2"],
  [/^(kg|kgs|kilos?|kilogramos?)$/, "kg"],
  [/^(m|mts?|mtrs?|metros?|ml|metros? lineales?)$/, "m"],
  [/^(mallas?)$/, "malla"],
  [/^(l|lts?|litros?)$/, "l"],
  [/^(u|un|uds?|unid|unidades?|piezas?|ladrillos?|canos?|codos?)$/, "unidad"],
];

export interface UnitInfo {
  code: string;
  label: string;
  singular: string;
  plural: string;
}

export function unitCodeFromWord(word: string | null | undefined, known: UnitInfo[]): string | null {
  if (!word) return null;
  const w = normalizeText(word).replace(/\.$/, "");
  const direct = known.find((u) => [u.code, u.label, u.singular, u.plural].some((x) => normalizeText(x) === w));
  if (direct) return direct.code;
  const hit = WORDS.find(([re]) => re.test(w));
  return hit && known.some((u) => u.code === hit[1]) ? hit[1] : null;
}

// ------------------------------------------------------------------ purchase format

/** Size of one purchase unit: a 12 m bar, a 50 kg bag. Thousandths of `unit`. */
export interface UnitSize {
  milli: number;
  unit: string;
}

export interface PurchaseFormat {
  /** What the supplier counts: barra, bolsa… */
  pieceUnit: string;
  size: UnitSize;
}

const PIECE_WORDS: [RegExp, string][] = [
  [/^(barras?|varillas?)$/, "barra"],
  [/^(bolsas?|bls?)$/, "bolsa"],
];
const SIZE_UNITS: [RegExp, string][] = [
  [/^(m|mt|mts|mtr|mtrs|metros?)$/, "m"],
  [/^(kg|kgs|kilos?|kilogramos?)$/, "kg"],
];
const NUMBER = String.raw`(\d{1,3}(?:[.,]\d{1,3})?)`;
// "x barra 12 mt", "barra de 12 m", "barras x 12 mts", "bolsa x 50 kg", "bolsa de 25 kilos"
const PIECE_THEN_SIZE = new RegExp(String.raw`\b(barras?|varillas?|bolsas?|bls?)\s*(?:x|de|por)?\s*${NUMBER}\s*(m|mt|mts|mtr|mtrs|metros?|kg|kgs|kilos?|kilogramos?)\b`);

function codeOf(word: string, table: [RegExp, string][]): string | null {
  return table.find(([re]) => re.test(word))?.[1] ?? null;
}

/**
 * Reads the purchase format printed in an item description. Only explicit
 * piece + size wording counts ("X BARRA 12 MT", "bolsa x 50 kg"); a lone
 * number is never taken as a size, so "barra del 12" (a Ø12 bar) is not a
 * 12 m bar. For bags, "Cemento 50 kg" with the purchase unit `bolsa` also
 * gives the bag size.
 */
export function parsePurchaseFormat(description: string, purchaseUnit?: string | null): PurchaseFormat | null {
  const t = normalizeText(description);
  const m = PIECE_THEN_SIZE.exec(t);
  if (m) {
    const pieceUnit = codeOf(m[1]!, PIECE_WORDS);
    const unit = codeOf(m[3]!, SIZE_UNITS);
    const milli = toMilli(m[2]!);
    // A bar is measured in meters and a bag in kilograms; anything else is not a size.
    if (pieceUnit && unit && milli && milli > 0 && ((pieceUnit === "barra" && unit === "m") || (pieceUnit === "bolsa" && unit === "kg"))) return { pieceUnit, size: { milli, unit } };
  }
  if (purchaseUnit === "bolsa") {
    const kg = [...t.matchAll(new RegExp(String.raw`\b${NUMBER}\s*(?:kg|kgs|kilos?)\b`, "g"))];
    const milli = kg.length === 1 ? toMilli(kg[0]![1]!) : null;
    if (milli && milli > 0) return { pieceUnit: "bolsa", size: { milli, unit: "kg" } };
  }
  return null;
}

export interface OrderLineUnit {
  /** Purchase unit code. */
  unit: string;
  size: UnitSize | null;
  /** The provider gave the size unit as the purchase unit ("172 m" for "X BARRA 12 MT"). */
  corrected: boolean;
}

/**
 * Decides the purchase unit of an order line from its description and the
 * unit word read next to the quantity. When the description states a piece
 * format ("X BARRA 12 MT"), the quantity counts pieces: a unit equal to the
 * piece size unit (m) is the size misread as the unit, so it becomes `barra`
 * with a 12 m size. A different explicit unit (sold by kg) is kept as is.
 */
export function resolveOrderLineUnit(description: string, unitWord: string | null | undefined, known: UnitInfo[], fallback: string | null): OrderLineUnit | null {
  const explicit = unitCodeFromWord(unitWord, known);
  const format = parsePurchaseFormat(description, explicit ?? fallback);
  if (format && known.some((u) => u.code === format.pieceUnit)) {
    if (!explicit || explicit === format.pieceUnit || explicit === "unidad") return { unit: format.pieceUnit, size: format.size, corrected: false };
    if (explicit === format.size.unit) return { unit: format.pieceUnit, size: format.size, corrected: true };
  }
  const unit = explicit ?? fallback;
  return unit ? { unit, size: null, corrected: false } : null;
}
