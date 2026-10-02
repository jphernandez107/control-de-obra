import { addDays } from "../domain/time";
import { normalizeText } from "../domain/text";
import type { AIInput, AIProvider, AIQuestionContext, DocumentInput } from "./provider";
import { emptyExtraction, type AIAnswer, type Extraction } from "./schemas";

// Deterministic stand-in for a language model. It recognizes common Spanish
// phrasings from the construction site with rules, so the whole review →
// confirm flow works offline and in tests. It returns exactly the same
// schema as a real provider and is subject to the same validation.

const UNIT_WORDS =
  "barras?|bolsas?|m3|m³|metros? cubicos?|m2|m²|kg|kilos?|mallas?|unidades|u|litros?|metros?|mts?|canos?|codos?|ladrillos?";

function cleanNumber(raw: string): number | null {
  let t = raw.trim();
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "$500.000", "500 mil", "1,5 millones" → pesos. */
export function parseAmountText(text: string): number | null {
  const t = normalizeText(text);
  const millions = /(\d+(?:[.,]\d+)?)\s*(?:millones|millon|palos?)\b/.exec(t);
  if (millions) return Math.round((cleanNumber(millions[1]!) ?? 0) * 1_000_000);
  const thousands = /(\d+(?:[.,]\d+)?)\s*(?:mil|lucas?)\b/.exec(t);
  if (thousands) return Math.round((cleanNumber(thousands[1]!) ?? 0) * 1000);
  const money = /\$\s*([\d.]+(?:,\d{1,2})?)/.exec(text) ?? /(?:total|importe|monto)[^\d]{0,12}([\d.]+(?:,\d{1,2})?)/i.exec(text) ?? /\b(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?)\b/.exec(text);
  if (money) return cleanNumber(money[1]!);
  return null;
}

function parseDate(text: string, today: string): string | null {
  const t = normalizeText(text);
  if (/\bhoy\b/.test(t)) return today;
  if (/\bayer\b/.test(t)) return addDays(today, -1);
  if (/\banteayer\b/.test(t)) return addDays(today, -2);
  const m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today.slice(0, 4);
    return `${year}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return null;
}

function orderReference(text: string): string | null {
  const m = /pedido\s*(?:n(?:ro|°|º|o)?\.?\s*)?#?\s*([a-z]{0,3}-?\d+)/i.exec(text.normalize("NFD").replace(/[̀-ͯ]/g, ""));
  return m ? m[1]!.toUpperCase() : null;
}

function remitoNumber(text: string): string | null {
  const m = /remito\s*(?:n(?:ro|°|º|o)?\.?\s*)?:?\s*([\d][\d-]*\d)/i.exec(text);
  return m ? m[1]! : null;
}

function paymentMethod(text: string): Extraction["paymentMethod"] {
  const t = normalizeText(text);
  if (/transfer/.test(t)) return "transferencia";
  if (/efectivo|cash/.test(t)) return "efectivo";
  if (/cheque|echeq/.test(t)) return "cheque";
  return null;
}

/** Supplier mention: a known supplier (by a distinctive word) or the capitalized phrase after "a"/"de". */
function supplierMention(text: string, suppliers: string[]): string | null {
  const t = normalizeText(text);
  for (const name of suppliers) {
    const n = normalizeText(name);
    if (t.includes(n)) return name;
  }
  for (const name of suppliers) {
    const words = normalizeText(name)
      .split(" ")
      .filter((w) => w.length >= 5 && !["corralon", "proveedor"].includes(w));
    if (words.some((w) => new RegExp(`\\b${w.slice(0, Math.max(5, w.length - 2))}`).test(t))) return name;
  }
  const m = /\b(?:a|de|del|con)\s+((?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)(?:\s+(?:del?|la|los|las|y|[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+))*)/.exec(text);
  if (m && !/^(Pedido|Remito)$/.test(m[1]!.split(" ")[0]!)) return m[1]!.replace(/\s+(del?|la|los|las|y)$/, "");
  return null;
}

/** "20 barras del 12 y 30 del 10" → items; a missing unit/material inherits the previous segment's. */
function parseItems(text: string, supplier: string | null): Extraction["items"] {
  let body = text;
  if (supplier) body = body.replace(new RegExp(`\\b(?:a|al|de|del|con)\\s+${supplier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), " ");
  body = body
    .replace(/pedido\s*(?:n(?:ro|°|º|o)?\.?\s*)?#?\s*[a-z]{0,3}-?\d+/gi, " ")
    .replace(/remito\s*(?:n(?:ro|°|º|o)?\.?\s*)?:?\s*[\d-]+/gi, " ")
    .replace(/\$\s*[\d.,]+/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ");
  const segments = body.split(/\s*(?:,|;|\n|\by\b|\be\b|\+)\s*/i);
  const items: Extraction["items"] = [];
  let lastUnit: string | null = null;
  let lastHead = "";
  const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_WORDS})?\\b\\.?\\s*(.*)$`, "i");
  for (const segment of segments) {
    const s = segment.trim();
    const m = re.exec(s);
    if (!m) continue;
    const quantity = cleanNumber(m[1]!);
    if (quantity === null || quantity <= 0) continue;
    let unit = m[2] ?? null;
    let rest = (m[3] ?? "")
      .replace(/^(de|del|de la|de los)\s+/i, "")
      .replace(/\s+(a|al|para|que|llegaron|llego|pidio|ya)\b.*$/i, "")
      .replace(/[.!?]+$/, "")
      .trim();
    // "30 del 10" → same kind of material as the previous segment ("barras del 10").
    const bareDiameter = /^(?:del?\s*)?(\d{1,2}(?:[.,]\d)?)$/.exec(rest);
    if (!unit && lastUnit && (bareDiameter || /^\d/.test(rest))) unit = lastUnit;
    if (bareDiameter) rest = `${lastHead || unit || ""} del ${bareDiameter[1]}`.trim();
    else if (/^\d{1,2}$/.test(rest) && unit) rest = `${unit} del ${rest}`;
    const unitWord = unit ? normalizeText(unit) : null;
    let material = rest;
    // "20 barras del 12" → material "barras del 12" (the unit word is part of how steel is named).
    if (unitWord && /^barras?$/.test(unitWord) && /^(?:del?\s*)?\d/.test(rest)) material = `barras ${rest.startsWith("de") ? rest : `del ${rest}`}`.replace(/del del/, "del");
    if (unitWord && /^(ladrillos?|canos?|codos?|mallas?)$/.test(unitWord)) material = `${unit} ${rest}`.trim();
    if (!material) continue;
    items.push({ material, quantity, unit, unitPrice: null });
    lastUnit = unit;
    lastHead = unitWord && /^barras?$/.test(unitWord) ? "barras" : lastHead;
  }
  return items;
}

function queryOf(text: string, suppliers: string[]): Extraction["query"] {
  const t = normalizeText(text);
  const supplier = supplierMention(text, suppliers);
  const ref = orderReference(text);
  if (/sin imputar/.test(t)) return { type: "unallocated_payments", supplier, material: null, orderReference: null };
  if (/pendientes? de entrega|falta(n)? (entregar|llegar)|sin entregar|que falta|no llego|no llegaron/.test(t)) return { type: "pending_deliveries", supplier, material: null, orderReference: ref };
  if (/pasando del computo|computo|previsto|nos pasamos/.test(t)) return { type: "computation_status", supplier: null, material: null, orderReference: null };
  if (/debemos|debo|saldo|deuda|adeud/.test(t)) return { type: supplier ? "supplier_balance" : "total_balance", supplier, material: null, orderReference: null };
  const qty = /cuant[oa]s?\s+(.+?)\s+(?:llevamos|hemos|tenemos|pedimos|se pidi|van|fueron|nos)/.exec(t);
  if (qty) return { type: "material_quantity", supplier: null, material: qty[1]!.replace(/^(de|del)\s+/, ""), orderReference: null };
  if (ref && /como (esta|va)|estado|que paso/.test(t)) return { type: "order_status", supplier: null, material: null, orderReference: ref };
  return { type: "general", supplier, material: null, orderReference: ref };
}

export function extractFromText(text: string, today: string, suppliers: string[]): Extraction {
  const t = normalizeText(text);
  const out = emptyExtraction();
  out.supplier = supplierMention(text, suppliers);
  out.orderReference = orderReference(text);
  out.date = parseDate(text, today);
  out.remito = remitoNumber(text);
  out.paymentMethod = paymentMethod(text);
  const isQuestion = /[¿?]/.test(text) || /^(cuanto|cuantos|cuanta|que|cual|como|nos estamos|hay|tenemos)\b/.test(t);

  if (/\bimputa(r|mos|le)?\b/.test(t) && !isQuestion) {
    out.intent = "allocate_payment";
    out.confidence = 0.8;
    out.amount = parseAmountText(text);
    return out;
  }
  if (isQuestion) {
    out.intent = "ask_query";
    out.query = queryOf(text, suppliers);
    out.confidence = out.query?.type === "general" ? 0.4 : 0.9;
    return out;
  }
  if (/\bpag(amos|ue|o|aron|ado|ar)\b|transferi|abonamos|deposit/.test(t)) {
    out.amount = parseAmountText(text);
    out.toCurrentAccount = /cuenta corriente|a cuenta|sin imputar/.test(t);
    out.paysFullOrderBalance = Boolean(out.orderReference) && /complet|total|todo|saldo|lo que (falta|debemos)/.test(t);
    const parts = [...text.matchAll(/(\$?\s*[\d.,]+\s*(?:mil|millones?)?)\s+(?:al|para el)\s+pedido\s*#?\s*([a-z]{0,3}-?\d+)/gi)];
    if (parts.length) out.allocations = parts.map((p) => ({ orderReference: p[2]!.toUpperCase(), amount: parseAmountText(p[1]!) }));
    out.intent = out.paysFullOrderBalance ? "pay_order_balance" : out.toCurrentAccount ? "record_supplier_account_payment" : "create_payment";
    out.confidence = out.amount !== null || out.paysFullOrderBalance ? 0.9 : 0.6;
    return out;
  }
  if (/llegaron|llego|se entrego|entregaron|entrego|recibimos|descargaron|trajeron|vino|vinieron/.test(t)) {
    out.deliverAllPending = /todo lo pendiente|lo pendiente|todo el pedido|lo que faltaba|el resto|lo que quedaba|todo lo que falta|completo/.test(t);
    out.items = out.deliverAllPending ? [] : parseItems(text, out.supplier);
    out.intent = out.deliverAllPending ? "complete_order_delivery" : "register_delivery";
    out.confidence = 0.85;
    return out;
  }
  if (/pidio|pedimos|encargo|encargamos|compramos|compro|pidieron|\bpedi\b|hicimos un pedido|pedido de/.test(t)) {
    const who = /^(\w+)\s+(?:pidio|encargo|compro)/.exec(t);
    out.orderedBy = who ? who[1]!.charAt(0).toUpperCase() + who[1]!.slice(1) : null;
    out.items = parseItems(text.replace(/^\s*\w+\s+(pidi[oó]|encarg[oó]|compr[oó])\s+/i, ""), out.supplier);
    out.purchaseMode = /contado|efectivo/.test(t) ? "contado" : null;
    const total = /total\s*(?:de)?\s*\$?\s*[\d.,]+/.exec(t) ? parseAmountText(text.slice(t.indexOf("total"))) : null;
    out.orderTotal = total;
    out.intent = "create_order";
    out.confidence = out.items.length ? 0.85 : 0.5;
    return out;
  }
  out.intent = "unknown";
  out.confidence = 0.2;
  return out;
}

// ------------------------------------------------------------------ documents

/** Text from simple, uncompressed PDFs (`(text) Tj`). Real scans need a real model. */
export function extractPdfText(data: Uint8Array): string {
  const raw = new TextDecoder("latin1").decode(data);
  const lines: string[] = [];
  for (const block of raw.matchAll(/BT([\s\S]*?)ET/g)) {
    const parts = [...block[1]!.matchAll(/\((.*?)(?<!\\)\)\s*Tj/g)].map((m) => m[1]!.replace(/\\([()\\])/g, "$1"));
    if (parts.length) lines.push(parts.join(""));
  }
  return lines.join("\n");
}

function documentTypeOf(text: string): Extraction["documentType"] {
  const t = normalizeText(text);
  if (/borros|ilegible|blur/.test(t)) return "unreadable";
  if (/remito|nota de entrega|entregado|comprobante de entrega/.test(t)) return "delivery_proof";
  if (/transferencia|comprobante de pago|recibo|pago|pagamos|operacion/.test(t)) return "payment_proof";
  if (/pedido|presupuesto|orden de compra|nota de venta|cotizacion/.test(t)) return "order_proof";
  return "other";
}

export class MockAIProvider implements AIProvider {
  readonly name = "mock";
  readonly model = "reglas-locales";

  async interpret(input: AIInput): Promise<Extraction> {
    return extractFromText(input.text, input.context.today, input.context.suppliers);
  }

  async analyzeDocument(input: DocumentInput): Promise<Extraction> {
    const body = input.mimeType === "application/pdf" ? extractPdfText(input.data) : "";
    const combined = [input.fileName.replace(/[_-]+/g, " "), input.text ?? "", body].join("\n");
    const documentType = documentTypeOf(`${input.fileName} ${body} ${input.text ?? ""}`);
    if (documentType === "unreadable" || (!body && documentType === "other" && !input.text)) {
      const out = emptyExtraction();
      out.documentType = "unreadable";
      out.note = "No se distinguen importes ni cantidades.";
      return out;
    }
    const lines = body ? body.split("\n") : [];
    const itemText = lines.filter((l) => /^\s*\d/.test(l)).join("\n");
    const base = extractFromText(`${input.text ?? ""}\n${body}`, input.context.today, input.context.suppliers);
    const out: Extraction = { ...base, documentType, confidence: body ? 0.8 : 0.5 };
    out.supplier = supplierMention(combined, input.context.suppliers);
    out.orderReference = orderReference(combined);
    out.remito = remitoNumber(combined);
    const fecha = /fecha:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(body);
    out.date = fecha ? parseDate(fecha[1]!, input.context.today) : base.date;
    out.items = itemText ? parseItems(itemText, out.supplier).map((it) => ({ ...it, unitPrice: priceFor(lines, it.material) })) : base.items;
    if (documentType === "delivery_proof") {
      out.intent = out.items.length ? "register_delivery" : "complete_order_delivery";
      out.deliverAllPending = !out.items.length;
    } else if (documentType === "payment_proof") {
      out.amount = parseAmountText(body || combined);
      out.paymentMethod = paymentMethod(combined) ?? "transferencia";
      out.items = [];
      // A receipt is a current-account payment only when it says so ("a cuenta").
      out.intent = !out.orderReference && out.toCurrentAccount ? "record_supplier_account_payment" : "create_payment";
    } else if (documentType === "order_proof") {
      out.intent = "create_order";
      const total = /total[^\d$]*\$?\s*([\d.]+(?:,\d{1,2})?)/i.exec(body);
      out.orderTotal = total && !out.items.some((i) => i.unitPrice !== null) ? cleanNumber(total[1]!) : null;
    } else out.intent = "unknown";
    return out;
  }

  async answer(input: AIQuestionContext): Promise<AIAnswer> {
    void input;
    return {
      text: "Puedo registrar pedidos, entregas y pagos, o responder sobre saldos, entregas pendientes y el cómputo. Prueba con «¿Cuánto debemos a Hierros Córdoba?» o «Llegaron las 20 barras del 12».",
    };
  }
}

function priceFor(lines: string[], material: string): number | null {
  const line = lines.find((l) => normalizeText(l).includes(normalizeText(material).split(" ").slice(-1)[0]!));
  const m = line ? /\$\s*([\d.]+(?:,\d{1,2})?)/.exec(line) : null;
  return m ? cleanNumber(m[1]!) : null;
}
