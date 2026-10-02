import { normalizeText } from "./text";

// Maps unit words people write ("barras", "bolsas", "m3", "metros cúbicos")
// to unit codes from the `units` table.

const WORDS: [RegExp, string][] = [
  [/^(barras?|br)$/, "barra"],
  [/^(bolsas?|bls?)$/, "bolsa"],
  [/^(m3|m³|mts3|metros? cubicos?|metro cubico)$/, "m3"],
  [/^(m2|m²|mts2|metros? cuadrados?)$/, "m2"],
  [/^(kg|kgs|kilos?|kilogramos?)$/, "kg"],
  [/^(m|mts?|metros?|ml|metros? lineales?)$/, "m"],
  [/^(mallas?)$/, "malla"],
  [/^(l|lts?|litros?)$/, "l"],
  [/^(u|un|uds?|unid|unidades?|piezas?|ladrillos?|canos?|codos?)$/, "unidad"],
];

export function unitCodeFromWord(word: string | null | undefined, known: { code: string; label: string; singular: string; plural: string }[]): string | null {
  if (!word) return null;
  const w = normalizeText(word).replace(/\.$/, "");
  const direct = known.find((u) => [u.code, u.label, u.singular, u.plural].some((x) => normalizeText(x) === w));
  if (direct) return direct.code;
  const hit = WORDS.find(([re]) => re.test(w));
  return hit && known.some((u) => u.code === hit[1]) ? hit[1] : null;
}
