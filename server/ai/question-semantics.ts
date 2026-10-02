import { normalizeText } from "../domain/text";

// Application-owned meaning of a read-only question about a material. A
// provider may fill `metric` itself, but the application also reads it
// deterministically from the wording, so "¿cuántas barras del 12 se
// pidieron?" (ordered), "¿cuántas llegaron?" (delivered), "¿cuántas faltan
// que lleguen?" (pending delivery), "¿cuántas necesitamos?" (computation) and
// "¿cuánto falta pedir?" (computation − ordered) never get mixed up.

export const MATERIAL_METRICS = [
  "ordered_quantity",
  "delivered_quantity",
  "pending_delivery_quantity",
  "expected_quantity",
  "remaining_to_order_quantity",
  "ordered_amount",
  "unit_price",
  "purchase_history",
] as const;

export type MaterialMetric = (typeof MATERIAL_METRICS)[number];

const RULES: [RegExp, MaterialMetric][] = [
  [/\bcada\b.*\b(cost|sal|vale|cuest|pag)|\b(cost|sal|vale|cuest|pag)\w*\b.*\bcada\b|precio( unitario)?\b|\ba cuanto (esta|sale|salio|se pago|lo pagamos)|\bpor (barra|bolsa|unidad|kilo|kg|metro)\b.*\b(cost|sal|pag)/, "unit_price"],
  [/\b(salio|salieron|costo|costaron|cuesta|cuestan|gastamos|gastado|se gasto|importe|plata|monto)\b|\bcuanto (se )?pag(o|amos|aron) (por|en|de)\b/, "ordered_amount"],
  [/\bfalta(n)? (comprar|pedir|encargar)|\bqueda(n)? (por|para) (comprar|pedir)|\bresta(n)? (comprar|pedir)|\bhay que (comprar|pedir)|\bfalta(n)? por (comprar|pedir)/, "remaining_to_order_quantity"],
  [/\bfalta(n)? (que )?(lleg|entreg|traer|venir)|\bpendientes? de (entrega|llegar)|\bpor (llegar|entregar)\b|\bno (llego|llegaron|entregaron|vino|vinieron)|\bsin entregar\b|\bqueda(n)? por (llegar|entregar)/, "pending_delivery_quantity"],
  [/\bnecesit|\bcomputad|\bcomputo\b|\bprevist|\bpreve\b|\bpresupuestad|\bse calculo\b|\bhacen falta\b|\bhace falta\b/, "expected_quantity"],
  [/\b(llegaron|llego|recibimos|recibieron|recibido|entregaron|entrego|entregad[oa]s?|descargaron|trajeron|vino|vinieron|tenemos en obra|hay en obra)\b/, "delivered_quantity"],
  [/\b(historial|historia)\b|\bcuando (se )?(pidio|pidieron|pedimos|compramos|compro)\b|\ben que pedidos?\b|\bque pedidos\b/, "purchase_history"],
  [/\b(pidieron|pidio|pedimos|pedi|compramos|compraron|compro|encargamos|encargaron|ordenamos)\b|\bllevamos pedid|\b(se|fue|fueron|ha|han) (sido )?pedid/, "ordered_quantity"],
];

/** Bare "¿cuántas faltan?": in a delivery context it means ordered − delivered (not "falta pagar/pedir"). */
const BARE_MISSING = /\bfalta(n)?\b(?!\s+(pagar|pedir|comprar|encargar|imputar|cobrar|por (pagar|pedir|comprar)))/;
const MONEY_WORDS = /\b(pag|saldo|deb|deud|plata|cuenta corriente)/;

export function inferMetric(text: string): MaterialMetric | null {
  const t = normalizeText(text);
  for (const [re, metric] of RULES) if (re.test(t)) return metric;
  if (BARE_MISSING.test(t) && !MONEY_WORDS.test(t)) return "pending_delivery_quantity";
  return null;
}

/** Quantity metrics answer "how much of a material"; the others are about money or history. */
export function isQuantityMetric(m: MaterialMetric | null | undefined): boolean {
  return m === "ordered_quantity" || m === "delivered_quantity" || m === "pending_delivery_quantity" || m === "expected_quantity" || m === "remaining_to_order_quantity";
}

const UNIT_ASKED: [RegExp, string][] = [
  [/\b(metros? lineales?|ml|metros?|mts?)\b(?!\s*(cubic|cuadrad|3|2))/, "m"],
  [/\b(kilos?|kilogramos?|kgs?)\b/, "kg"],
  [/\b(barras?|varillas?)\b/, "barra"],
  [/\b(bolsas?|bolsones?)\b/, "bolsa"],
  [/\b(m3|metros? cubicos?)\b/, "m3"],
  [/\b(m2|metros? cuadrados?)\b/, "m2"],
  [/\b(mallas?)\b/, "malla"],
  [/\b(unidades|piezas)\b/, "unidad"],
];

/**
 * The unit the question asks the answer in: "¿cuántos metros lineales…?" → m,
 * "¿cuántos kilos…?" → kg, "¿cuántas barras…?" → barra. Only a unit right after
 * "cuántos/cuántas" or after "en" ("…en metros") counts.
 */
export function inferRequestedUnit(text: string): string | null {
  const t = normalizeText(text);
  const asked = /\bcuant[oa]s?\s+(.{1,30})/.exec(t)?.[1] ?? "";
  const inUnit = /\ben (metros? lineales?|metros?|kilos?|kg|barras?|bolsas?|m3|m2)\b/.exec(t)?.[1] ?? "";
  for (const source of [inUnit, asked]) {
    if (!source) continue;
    const head = source.split(/\s+(?:de|del|se|nos|llegaron|faltan|hay|tenemos|pedimos|necesitamos)\b/)[0]!;
    for (const [re, unit] of UNIT_ASKED) if (re.exec(head)?.index === 0) return unit;
  }
  return null;
}

// Words that carry the question, not the material ("¿cuántas … se pidieron?").
const QUESTION_WORDS = new Set(
  (
    "y e cuanto cuanta cuantos cuantas que cual cuales como cuando donde se nos les le lo la las el los un una unos unas de del al a en por para con " +
    "pidieron pidio pedimos pedi pedido pedidos pedida pedidas compramos compraron compro encargamos ordenamos llevamos van fueron hay tenemos tienen " +
    "llegaron llego llegue lleguen recibimos recibieron entregaron entrego entregue entreguen entregado entregados entregada entregadas descargaron trajeron traigan vino vinieron llegar entregar " +
    "falta faltan queda quedan resta restan comprar pedir necesitamos necesita necesitan hace hacen computado computada computo previsto prevista preve " +
    "salio salieron costo costaron cuesta cuestan vale valen pagamos pago pagaron gastamos precio unitario cada total todo toda todos todas " +
    "es son esta estan fue era ya aun todavia hasta ahora hoy obra metros metro lineales lineal kilos kilo kilogramos kg mts unidades piezas toneladas"
  ).split(" "),
);

/** What is left of a question once the question words are removed ("¿cuántas barras del 12 se pidieron?" → "barras 12"). Null when nothing is left. */
export function materialMentionIn(text: string): string | null {
  const words = normalizeText(text)
    .replace(/[?¿!¡.,;:]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !QUESTION_WORDS.has(w));
  // "pedido 38" / "remito 12" name a record, not a material.
  const cleaned = words.join(" ").replace(/\b(pedido|remito|n|nro|numero)\s*#?\d+\b/g, " ").replace(/\s+/g, " ").trim();
  return cleaned && /[a-z0-9]/.test(cleaned) ? cleaned : null;
}
