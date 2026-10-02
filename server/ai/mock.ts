import { formatMoney } from "../../src/domain/format";
import { addDays } from "../domain/time";
import { normalizeText } from "../domain/text";
import { isGenericMaterialMention, matchMaterial } from "../domain/matching";
import type { AIConversationContext, AIDocumentInput, AIInterpretationInput, AIProjectContext, AIProvider, AIQuestionInput } from "./provider";
import { inferMetric, inferRequestedUnit, isQuantityMetric, materialMentionIn, type MaterialMetric } from "./question-semantics";
import type { AIAnswerResult, AIInterpretation, AIInterpretationResult, DocumentType, ItemMention, ProjectQuestion } from "./schemas";

// Deterministic stand-in for a language model (AI_PROVIDER=mock). It
// recognizes common Spanish phrasings from the construction site with rules,
// so the whole interpret → review → confirm flow works offline and in tests.
// It returns exactly the same contract as a real provider and goes through
// the same validation. It has no general intelligence on purpose.

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

function paymentMethod(text: string): "transferencia" | "efectivo" | "cheque" | null {
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
  // Within one line: a printed document's next line is not part of the name.
  const m = /\b(?:a|de|del|con)[ \t]+((?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)(?:[ \t]+(?:del?|la|los|las|y|[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+))*)/.exec(text);
  if (m && !/^(Pedido|Remito)$/.test(m[1]!.split(" ")[0]!)) return m[1]!.replace(/\s+(del?|la|los|las|y)$/, "");
  return null;
}

/** "20 barras del 12 y 30 del 10" → items; a missing unit/material inherits the previous segment's. */
function parseItems(text: string, supplier: string | null): ItemMention[] {
  let body = text;
  if (supplier) body = body.replace(new RegExp(`\\b(?:a|al|de|del|con)\\s+${supplier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), " ");
  body = body
    .replace(/pedido\s*(?:n(?:ro|°|º|o)?\.?\s*)?#?\s*[a-z]{0,3}-?\d+/gi, " ")
    .replace(/remito\s*(?:n(?:ro|°|º|o)?\.?\s*)?:?\s*[\d-]+/gi, " ")
    .replace(/\$\s*[\d.,]+/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ");
  const segments = body.split(/\s*(?:,|;|\n|\by\b|\be\b|\+)\s*/i);
  const items: ItemMention[] = [];
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

type Question = Omit<ProjectQuestion, "intent" | "confidence" | "note">;

const MATERIAL_QUERY: Record<MaterialMetric, Question["query"]> = {
  ordered_quantity: "get_material_order_summary",
  ordered_amount: "get_material_order_summary",
  unit_price: "get_material_order_summary",
  purchase_history: "get_material_history",
  delivered_quantity: "get_material_delivery_summary",
  pending_delivery_quantity: "get_material_delivery_summary",
  expected_quantity: "get_computation_comparison",
  remaining_to_order_quantity: "get_computation_comparison",
};

function question(text: string, suppliers: string[], conversation?: AIConversationContext, materials: AIProjectContext["materials"] = []): Question {
  const t = normalizeText(text);
  const supplier = supplierMention(text, suppliers);
  const ref = orderReference(text);
  const q = (query: Question["query"], extra: Partial<Question> = {}): Question => ({
    query,
    supplier: null,
    orderReference: null,
    material: null,
    aspect: null,
    refersToPrevious: false,
    ...extra,
  });
  // A follow-up that names nothing ("¿y cuánto falta pagar?") refers to the previous exchange.
  const followUp = !ref && !supplier && /^(y|e)\b|^(y )?(cuanto|como|que)\b.*\b(falta|viene|va|esta|queda)\b/.test(t);
  if (/sin imputar/.test(t)) return q("list_unallocated_payments", { supplier });
  if (/entregad[oa]s? (y|pero)? ?(no|sin) pag|entregad[oa]s? sin pagar|llegaron y no (pagamos|se pagaron)/.test(t)) return q("list_delivered_unpaid_orders", { supplier });
  // A fact about one material: "¿cuántas barras del 12 se pidieron?", "¿y cuántas llegaron?".
  const metric = inferMetric(text);
  const mention = materialMentionIn(text);
  // Like a model reading the catalog it was given: the mention must name a known material.
  const catalog = materials.map((m, i) => ({ id: String(i), name: m.name, shortName: m.name, aliases: m.aliases, baseUnit: m.unit }));
  const named = Boolean(mention && !isGenericMaterialMention(mention) && matchMaterial(mention, catalog).status !== "new");
  const previousMaterial = Boolean(conversation?.focus.material);
  if (metric && !ref && (named || (followUp && !supplier && previousMaterial) || (mention && isGenericMaterialMention(mention) && isQuantityMetric(metric)))) {
    // Only a supplier named in full: "hierro" is a material here, not "Hierros Córdoba".
    const namedSupplier = suppliers.find((n) => t.includes(normalizeText(n))) ?? null;
    return q(MATERIAL_QUERY[metric], { material: named ? mention : null, supplier: namedSupplier, metric, unit: inferRequestedUnit(text), refersToPrevious: !named });
  }
  if (/falta(n)? pagar|saldo del pedido|debemos del pedido|queda por pagar/.test(t) && (ref || !supplier)) return q("get_order_summary", { orderReference: ref, aspect: "payment", refersToPrevious: !ref });
  if (/pendientes? de entrega|falta(n)? (entregar|llegar)|sin entregar|que falta|no llego|no llegaron|entregas pendientes/.test(t)) {
    if (ref || followUp) return q("get_order_summary", { orderReference: ref, aspect: "delivery", refersToPrevious: !ref });
    return q("list_orders_pending_delivery", { supplier });
  }
  if (/pasando del computo|computo|previsto|nos pasamos/.test(t)) return q("get_computation_variance");
  if (/debemos|debo|saldo|deuda|adeud|cuenta corriente/.test(t)) return supplier ? q("get_supplier_summary", { supplier }) : q("list_supplier_balances");
  const qty = /cuant[oa]s?\s+(.+?)\s+(?:llevamos|hemos|tenemos|van|fueron|nos)/.exec(t);
  if (qty) return q("get_material_summary", { material: qty[1]!.replace(/^(de|del)\s+/, "") });
  if (/como (esta|va|viene)|estado|que paso/.test(t) && (ref || followUp)) return q("get_order_summary", { orderReference: ref, aspect: "overall", refersToPrevious: !ref });
  return q("general", { supplier, orderReference: ref });
}

function result(interpretation: AIInterpretation, document: { type: DocumentType; confidence: number } | null = null): AIInterpretationResult {
  return { interpretation, document, meta: { provider: "mock", model: "reglas-locales" } };
}

/** Rules for a plain message. Exported for tests. */
export function interpretText(text: string, today: string, suppliers: string[], conversation?: AIConversationContext, materials: AIProjectContext["materials"] = []): AIInterpretation {
  const t = normalizeText(text);
  const supplier = supplierMention(text, suppliers);
  const ref = orderReference(text);
  const date = parseDate(text, today);
  const method = paymentMethod(text);
  const isQuestion = /[¿?]/.test(text) || /^(y |e )?(cuanto|cuantos|cuanta|que|cual|como|nos estamos|hay|tenemos)\b/.test(t);
  const base = { confidence: 0.85, note: null };

  if (/\bimputa(r|mos|le)?\b/.test(t) && !isQuestion) {
    return { intent: "allocate_payment", ...base, supplier, orderReference: ref, amount: parseAmountText(text) };
  }
  if (isQuestion) {
    const q = question(text, suppliers, conversation, materials);
    return { intent: "ask_project_question", ...base, confidence: q.query === "general" ? 0.4 : 0.9, ...q };
  }
  if (/\bpag(amos|ue|o|aron|ado|ar|alo|ala)\b|transferi|abonamos|deposit/.test(t)) {
    const amount = parseAmountText(text);
    const full = /complet|todo el pedido|el saldo del pedido|lo que (falta|debemos)|\btotal\b|\btodo\b/.test(t) && (Boolean(ref) || amount === null);
    if (full) return { intent: "pay_order_balance", ...base, orderReference: ref, supplier, date, paymentMethod: method, paymentReference: null };
    const parts = [...text.matchAll(/(\$?\s*[\d.,]+\s*(?:mil|millones?)?)\s+(?:al|para el)\s+pedido\s*#?\s*([a-z]{0,3}-?\d+)/gi)];
    if (amount === null && !parts.length) {
      return {
        intent: "clarification_required",
        ...base,
        confidence: 0.6,
        question: supplier ? `¿De cuánto fue el pago a ${supplier}?` : "¿De cuánto fue el pago y a qué proveedor?",
        possibleIntent: "create_supplier_payment",
        missing: supplier ? ["amount"] : ["amount", "supplier"],
      };
    }
    return {
      intent: "create_supplier_payment",
      ...base,
      supplier,
      amount,
      currency: /dolar|usd|u\$s/.test(t) ? "USD" : "ARS",
      date,
      paymentMethod: method,
      paymentReference: null,
      toCurrentAccount: /cuenta corriente|a cuenta|sin imputar/.test(t),
      orderReference: parts.length ? null : ref,
      allocations: parts.map((p) => ({ orderReference: p[2]!.toUpperCase(), amount: parseAmountText(p[1]!) })),
    };
  }
  if (/llegaron|llego|se entrego|entregaron|entrego|recibimos|descargaron|trajeron|vino|vinieron/.test(t)) {
    const all = /todo lo pendiente|lo pendiente|todo el pedido|lo que faltaba|el resto|lo que quedaba|todo lo que falta|completo/.test(t);
    const items = all ? [] : parseItems(text, supplier);
    if (all || !items.length) return { intent: "complete_order_delivery", ...base, orderReference: ref, supplier, deliveryReference: remitoNumber(text), date };
    return {
      intent: "register_delivery",
      ...base,
      orderReference: ref,
      supplier,
      deliveryReference: remitoNumber(text),
      date,
      items: items.flatMap((i) => (i.quantity === null ? [] : [{ material: i.material, quantity: i.quantity, unit: i.unit }])),
    };
  }
  if (/pidio|pedimos|encargo|encargamos|compramos|compro|pidieron|\bpedi\b|hicimos un pedido|pedido de/.test(t)) {
    const who = /^(\w+)\s+(?:pidio|encargo|compro)/.exec(t);
    const items = parseItems(text.replace(/^\s*\w+\s+(pidi[oó]|encarg[oó]|compr[oó])\s+/i, ""), supplier);
    if (!items.length) {
      return { intent: "clarification_required", ...base, confidence: 0.5, question: "Entendí que se hizo un pedido. ¿Qué materiales y cantidades se pidieron, y a qué proveedor?", possibleIntent: "create_order", missing: ["items"] };
    }
    const total = /total\s*(?:de)?\s*\$?\s*[\d.,]+/.exec(t) ? parseAmountText(text.slice(t.indexOf("total"))) : null;
    return {
      intent: "create_order",
      ...base,
      supplier,
      orderReference: ref,
      date,
      requestedBy: who ? who[1]!.charAt(0).toUpperCase() + who[1]!.slice(1) : null,
      purchaseMode: /contado|efectivo/.test(t) ? "contado" : null,
      items,
      orderTotal: total,
    };
  }
  void conversation;
  return { intent: "unknown", confidence: 0.2, note: null };
}

function documentTypeOf(text: string): { type: DocumentType; confidence: number } {
  const t = normalizeText(text);
  if (/borros|ilegible|cortad/.test(t)) return { type: "unknown", confidence: 0.2 };
  if (/remito|nota de entrega|comprobante de entrega/.test(t)) return { type: "delivery", confidence: 0.85 };
  if (/transferencia|comprobante de pago|recibo|pagamos|operacion/.test(t)) return { type: "payment", confidence: 0.85 };
  if (/pedido|presupuesto|orden de compra|nota de venta|cotizacion/.test(t)) return { type: "order", confidence: 0.85 };
  return { type: "unknown", confidence: 0.3 };
}

function priceFor(lines: string[], material: string): number | null {
  const line = lines.find((l) => normalizeText(l).includes(normalizeText(material).split(" ").slice(-1)[0]!));
  const m = line ? /\$\s*([\d.]+(?:,\d{1,2})?)/.exec(line) : null;
  return m ? cleanNumber(m[1]!) : null;
}

/** Rules for normalized document text. Unknown fields stay null. Exported for tests. */
export function interpretDocument(fileName: string, body: string, userText: string | undefined, today: string, suppliers: string[]): AIInterpretationResult {
  const combined = [fileName.replace(/[_-]+/g, " "), userText ?? "", body].join("\n");
  const doc = documentTypeOf(`${fileName} ${body} ${userText ?? ""}`);
  if (doc.type === "unknown") return result({ intent: "unknown", confidence: doc.confidence, note: null }, doc);
  const lines = body.split("\n");
  const supplier = supplierMention(combined, suppliers);
  const ref = orderReference(combined);
  const fecha = /fecha:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(body);
  const date = fecha ? parseDate(fecha[1]!, today) : parseDate(`${userText ?? ""}`, today);
  const itemLines = lines.filter((l) => /^\s*\d/.test(l));
  const items = itemLines.length ? parseItems(itemLines.join("\n"), supplier) : [];
  // One item per printed line: its first amount is the unit price.
  const linePrices = items.length === itemLines.length ? itemLines.map((l) => /\$\s*([\d.]+(?:,\d{1,2})?)/.exec(l)?.[1] ?? null) : null;
  const base = { confidence: doc.confidence, note: null };
  if (doc.type === "delivery") {
    if (!items.length) return result({ intent: "complete_order_delivery", ...base, orderReference: ref, supplier, deliveryReference: remitoNumber(combined), date }, doc);
    return result(
      {
        intent: "register_delivery",
        ...base,
        orderReference: ref,
        supplier,
        deliveryReference: remitoNumber(combined),
        date,
        items: items.flatMap((i) => (i.quantity === null ? [] : [{ material: i.material, quantity: i.quantity, unit: i.unit }])),
      },
      doc,
    );
  }
  if (doc.type === "payment") {
    const t = normalizeText(combined);
    return result(
      {
        intent: "create_supplier_payment",
        ...base,
        supplier,
        amount: parseAmountText(body || combined),
        currency: "ARS",
        date,
        paymentMethod: paymentMethod(combined) ?? "transferencia",
        paymentReference: /operaci[oó]n:?\s*(\w+)/i.exec(body)?.[1] ?? null,
        // A receipt is a current-account payment only when it says so ("a cuenta").
        toCurrentAccount: !ref && /cuenta corriente|a cuenta/.test(t),
        orderReference: ref,
        allocations: [],
      },
      doc,
    );
  }
  const priced = items.map((it, i) => ({ ...it, unitPrice: linePrices ? (linePrices[i] ? cleanNumber(linePrices[i]!) : null) : priceFor(lines, it.material) }));
  const total = /total[^\d$]*\$?\s*([\d.]+(?:,\d{1,2})?)/i.exec(body);
  return result(
    {
      intent: "create_order",
      ...base,
      supplier,
      orderReference: ref,
      date,
      requestedBy: null,
      purchaseMode: null,
      items: priced,
      orderTotal: total && !priced.some((i) => i.unitPrice !== null) ? cleanNumber(total[1]!) : null,
    },
    doc,
  );
}

export class MockAIProvider implements AIProvider {
  readonly id = "mock" as const;
  readonly name = "mock";
  readonly model = "reglas-locales";
  readonly configured = true;

  async interpret(input: AIInterpretationInput): Promise<AIInterpretationResult> {
    return result(interpretText(input.text, input.project.today, input.project.suppliers, input.conversation, input.project.materials));
  }

  async analyzeDocument(input: AIDocumentInput): Promise<AIInterpretationResult> {
    return interpretDocument(input.document.fileName, input.content.text, input.userText, input.project.today, input.project.suppliers);
  }

  /** Free-form questions: a fixed summary built only from the query results it is given. */
  async answer(input: AIQuestionInput): Promise<AIAnswerResult> {
    const parts: string[] = [];
    for (const r of input.results) {
      if (r.status !== "ok") continue;
      if (r.query === "list_supplier_balances") parts.push(`El saldo total con proveedores es de ${formatMoney(r.data.totalOutstandingMinor)}.`);
      if (r.query === "list_orders_pending_delivery") parts.push(r.data.orders.length ? `Hay ${r.data.orders.length} ${r.data.orders.length === 1 ? "pedido pendiente" : "pedidos pendientes"} de entrega.` : "No hay entregas pendientes.");
    }
    return {
      text: `${parts.join(" ")} Puedo registrar pedidos, entregas y pagos, o responder sobre saldos, entregas pendientes y el cómputo. Prueba con «¿Cuánto debemos a Hierros Córdoba?» o «Llegaron las 20 barras del 12».`.trim(),
      meta: { provider: "mock", model: "reglas-locales" },
    };
  }
}
