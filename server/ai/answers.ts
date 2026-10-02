import type { AssistantBlock, BalanceRow, MatchOption } from "../../src/domain/assistant";
import { formatDate, formatMoney, formatNumber } from "../../src/domain/format";
import type { Ledger } from "../domain/derive";
import { isGenericMaterialMention, steelSpec } from "../domain/matching";
import { materialFacts, type MaterialFilter } from "../domain/summaries";
import { normalizeText } from "../domain/text";
import { unitCodeFromWord } from "../domain/units";
import type { ContextRefs, ConversationFocus, ConversationState } from "./conversation-context";
import { renderMaterialAnswer } from "./material-answers";
import { isAIError } from "./errors";
import { runProjectQuery, type ProjectQueryResult, type ProjectQueryUnresolved, type ResolvedRefs } from "./project-queries";
import type { AIProvider } from "./provider";
import { inferMetric, inferRequestedUnit, isQuantityMetric, materialMentionIn, type MaterialMetric } from "./question-semantics";
import { resolveMaterial, resolveOrderReference, resolveSupplier, safeJsonArray } from "./resolve";
import type { ProjectQuestion, ProjectQueryName } from "./schemas";

// Read-only questions. The provider only classifies the question; the
// figures come from the read-only query layer (./project-queries.ts) and are
// rendered here deterministically. Free-form questions may be phrased by the
// provider, but only from query results — never from chat history.

function text(t: string): AssistantBlock {
  return { type: "text", text: t };
}

export interface AnswerResult {
  blocks: AssistantBlock[];
  refs: Partial<ContextRefs>;
  results: ProjectQueryResult[];
}

const NEEDS: Partial<Record<ProjectQueryName, "supplier" | "order" | "material">> = {
  get_supplier_summary: "supplier",
  get_order_summary: "order",
  get_order_items: "order",
  get_material_summary: "material",
};

/** Queries about one material, and the fact each one answers when the question does not say. */
const MATERIAL_QUERY_METRIC: Partial<Record<ProjectQueryName, MaterialMetric | "overview">> = {
  get_material_summary: "overview",
  get_material_order_summary: "ordered_quantity",
  get_material_delivery_summary: "delivered_quantity",
  get_material_history: "purchase_history",
  get_computation_comparison: "remaining_to_order_quantity",
};

/** Provider choices a material question may be re-routed from (the classic slip: a generic order summary). */
const REROUTABLE = new Set<string>(["general", "get_order_summary", "list_orders_pending_delivery", "get_computation_variance", "search_order_items", "search_materials"]);

const MISSING_QUESTION = {
  supplier: "¿De qué proveedor?",
  order: "¿De qué pedido? Indícame el número, por ejemplo «¿Cómo viene el pedido 38?».",
  material: "¿De qué material quieres saber la cantidad?",
};

function unresolvedBlocks(r: ProjectQueryUnresolved): AssistantBlock[] {
  if (r.status === "missing_argument" || r.status === "invalid_arguments") return [text(r.argument ? MISSING_QUESTION[r.argument] : "No entendí bien la consulta. ¿Puedes reformularla?")];
  const label = { supplier: "proveedor", order: "pedido", material: "material" }[r.argument ?? "order"];
  if (r.status === "not_found") {
    if (r.argument === "material") return [text(`No encontré «${r.mention}» en el catálogo de materiales.`)];
    if (r.argument === "supplier") return [text(`No encontré a «${r.mention}» entre los proveedores.`)];
    return [text(`No encontré el ${label} ${r.mention ?? ""}.`.replace(" .", "."))];
  }
  const prompt = (name: string) =>
    r.query === "get_material_summary" ? `¿Cuánto ${name} llevamos pedido?` : r.query === "get_order_summary" ? `¿Cómo viene el ${name.toLowerCase().split(" · ")[0]} de ${name.split(" · ")[1] ?? ""}?`.replace(" de ?", "?") : `¿Cuánto debemos a ${name}?`;
  return [
    text(`¿Te refieres a ${r.candidates.map((c) => c.name).join(" o ")}?`),
    { type: "actions", actions: r.candidates.slice(0, 4).map((c) => ({ label: c.name, icon: r.argument === "material" ? ("clipboard-list" as const) : ("store" as const), prompt: prompt(c.name) })) },
  ];
}

function pendingLabelOf(lines: { material: string; unit: string; remaining: number }[]): string {
  return lines
    .filter((l) => l.remaining > 0)
    .map((l) => `${formatNumber(l.remaining)} ${l.unit} ${l.material}`)
    .join(" y ");
}

/** Renders one successful query result into chat blocks. All numbers come from `result.data`. */
export function renderQueryResult(ledger: Ledger, result: ProjectQueryResult, question?: ProjectQuestion): AssistantBlock[] {
  if (result.status !== "ok") return unresolvedBlocks(result);
  switch (result.query) {
    case "get_supplier_summary": {
      const d = result.data;
      const rows: BalanceRow[] = [
        ...d.ordersWithBalance.map((o) => ({
          label: `Pedido ${o.number}`,
          description: o.paymentStatus === "parcial" ? `Pago parcial · pagado ${formatMoney(o.allocatedPaidMinor)}` : "Sin pagos",
          amount: o.remainingBalanceMinor,
          orderId: o.orderId,
        })),
        ...d.unknownValueOrders.map((o) => ({ label: `Pedido ${o.number}`, description: "Importe a confirmar", amount: null, orderId: o.orderId })),
        ...d.unallocatedPayments.map((p) => ({ label: "Sin imputar", description: `Pago del ${formatDate(p.date).slice(0, 5)}`, amount: -p.unallocatedMinor, unallocated: true })),
      ];
      const blocks: AssistantBlock[] = [
        text(`Hoy el saldo con ${d.supplier} es de ${formatMoney(d.outstandingBalanceMinor)}${d.unknownValueOrders.length ? " según los importes conocidos" : ""}.`),
        {
          type: "balance",
          supplierId: d.supplierId,
          ordered: d.knownOrderTotalMinor,
          paid: d.totalPaidMinor,
          balance: d.outstandingBalanceMinor,
          allocatedPaid: d.allocatedPaidMinor,
          unallocatedPaid: d.unallocatedPaidMinor,
          rows,
        },
      ];
      const unknown = d.unknownValueOrders.length;
      if (unknown) blocks.push({ type: "note", text: `${unknown === 1 ? "Hay 1 pedido" : `Hay ${unknown} pedidos`} sin importe cargado: el saldo real puede ser mayor. Completa los precios en el pedido para tener el total exacto.` });
      if (d.unallocatedPaidMinor > 0) {
        blocks.push(text(`${formatMoney(d.unallocatedPaidMinor)} de pagos todavía no están asignados a un pedido, pero ya reducen el saldo. ¿Quieres imputarlos?`), {
          type: "actions",
          actions: [
            { label: "Imputar el pago", icon: "git-fork", prompt: `Imputar el pago sin imputar de ${d.supplier}` },
            { label: "Ver cuenta corriente", icon: "store", link: { to: "/proveedores/$supplierId", params: { supplierId: d.supplierId } } },
          ],
        });
      }
      return blocks;
    }
    case "list_supplier_balances": {
      const d = result.data;
      const withBalance = d.suppliers.filter((s) => s.outstandingBalanceMinor !== 0 || s.unknownValueOrders);
      if (!withBalance.length) return [text("Hoy no hay saldos pendientes con proveedores.")];
      const unknown = d.suppliers.reduce((s, x) => s + x.unknownValueOrders, 0);
      return [
        text(
          `El saldo total con proveedores es de ${formatMoney(d.totalOutstandingMinor)}. ${withBalance
            .map((s) => `${s.supplier}: ${formatMoney(s.outstandingBalanceMinor)}${s.unknownValueOrders ? ` (+${s.unknownValueOrders} sin importe)` : ""}`)
            .join(" · ")}.`,
        ),
        ...(unknown ? [{ type: "note" as const, text: `${unknown === 1 ? "Un pedido no tiene" : `${unknown} pedidos no tienen`} importe cargado y no suman al total.` }] : []),
      ];
    }
    case "get_order_summary": {
      const d = result.data;
      const f = d.financial;
      const aspect = question?.aspect ?? "overall";
      const pending = pendingLabelOf(d.delivery.lines);
      if (aspect === "payment") {
        if (f.knownTotalMinor === null || f.remainingBalanceMinor === null) {
          return [text(`El pedido ${d.number} de ${d.supplier} no tiene importe cargado, así que no puedo calcular cuánto falta pagar${f.allocatedPaidMinor ? ` (lleva ${formatMoney(f.allocatedPaidMinor)} imputados)` : ""}. Completa los precios en el pedido.`)];
        }
        if (f.remainingBalanceMinor === 0) return [text(`El pedido ${d.number} de ${d.supplier} está pagado completo (${formatMoney(f.knownTotalMinor)}).`)];
        return [
          text(`Del pedido ${d.number} de ${d.supplier} falta pagar ${formatMoney(f.remainingBalanceMinor)}: vale ${formatMoney(f.knownTotalMinor)} y tiene ${formatMoney(f.allocatedPaidMinor)} imputados.`),
          { type: "actions", actions: [{ label: "Pagar el saldo", icon: "store", prompt: `Pagamos completo el pedido ${d.number} de ${d.supplier}` }] },
        ];
      }
      if (aspect === "delivery") {
        if (d.delivery.status === "entregado") return [text(`El pedido ${d.number} de ${d.supplier} está entregado completo.`)];
        return [text(`Del pedido ${d.number} de ${d.supplier} ${d.delivery.status === "pendiente" ? "no llegó nada todavía" : "llegó una parte"}: faltan ${pending}.`)];
      }
      const delivery = { pendiente: "pendiente de entrega", parcial: `con entrega parcial (faltan ${pending})`, entregado: "entregado completo" }[d.delivery.status];
      const payment = f.knownTotalMinor === null ? `sin importe cargado (pagado ${formatMoney(f.allocatedPaidMinor)})` : f.status === "pagado" ? "pagado" : `con saldo de ${formatMoney(f.remainingBalanceMinor ?? 0)} de ${formatMoney(f.knownTotalMinor)}`;
      return [text(`El pedido ${d.number} de ${d.supplier} (${formatDate(d.date)}) está ${delivery} y ${payment}.`)];
    }
    case "list_orders_pending_delivery": {
      const d = result.data;
      if (!d.orders.length) return [text("No hay pedidos pendientes de entrega. Todo lo pedido ya llegó.")];
      return [
        text(d.orders.length === 1 ? "Hay 1 pedido pendiente de entrega:" : `Hay ${d.orders.length} pedidos pendientes de entrega:`),
        {
          type: "pending_deliveries",
          rows: d.orders.map((o) => {
            const order = ledger.order(o.orderId)!;
            const label = ledger.pendingLabel(order) ?? `Faltan ${pendingLabelOf(o.lines)}`;
            return { orderId: o.orderId, orderNumber: o.number, supplier: o.supplier, pendingLabel: o.status === "pendiente" ? `Nada entregado · ${label.replace(/^Faltan /, "")}` : label };
          }),
        },
      ];
    }
    case "list_delivered_unpaid_orders": {
      const d = result.data;
      if (!d.orders.length) return [text("No hay pedidos entregados pendientes de pago.")];
      const known = d.orders.filter((o) => o.remainingBalanceMinor !== null);
      const unknown = d.orders.length - known.length;
      return [
        text(
          `${d.orders.length === 1 ? "Hay 1 pedido entregado" : `Hay ${d.orders.length} pedidos entregados`} sin pagar completo: ${d.orders
            .map((o) => `pedido ${o.number} de ${o.supplier} (${o.remainingBalanceMinor === null ? "importe a confirmar" : `saldo ${formatMoney(o.remainingBalanceMinor)}`})`)
            .join(" · ")}.`,
        ),
        ...(unknown ? [{ type: "note" as const, text: `${unknown === 1 ? "Uno no tiene" : `${unknown} no tienen`} importe cargado: completa los precios para conocer el saldo.` }] : []),
      ];
    }
    case "get_material_summary": {
      const d = result.data;
      const parts = [`Llevamos pedido ${formatNumber(d.ordered)} ${d.unit} de ${d.material}`, `${formatNumber(d.delivered)} ${d.unit} entregadas`];
      if (d.pendingDelivery) parts.push(`${formatNumber(d.pendingDelivery)} pendientes de entrega`);
      let computation: string;
      if (d.expected === null) computation = " Este material todavía no tiene cómputo para comparar.";
      else if (d.status === "supera") computation = ` Supera el cómputo (${formatNumber(d.expected)} ${d.unit}) en ${formatNumber(d.variance ?? 0)} ${d.unit}: conviene revisarlo.`;
      else computation = ` Es el ${d.percentOrdered}% del cómputo (${formatNumber(d.expected)} ${d.unit}); quedan ${formatNumber(d.remainingExpected ?? 0)} ${d.unit} por pedir.`;
      return [
        text(`${parts.join(", ")}.${computation}`),
        { type: "quantities", rows: [{ material: d.material, ordered: d.ordered, delivered: d.delivered, unit: d.unit }], computationPrompt: !ledger.computationInfo().loaded },
        { type: "actions", actions: [{ label: "Ver material", icon: "clipboard-list", link: { to: "/materiales" } }] },
      ];
    }
    case "get_computation_variance": {
      const d = result.data;
      if (!d.materials.length) return [text("Todavía no hay materiales registrados. Cuando registres el primer pedido podré compararlo con el cómputo.")];
      if (!d.loaded) {
        return [
          text("Aún no hay un cómputo cargado, así que no puedo compararlo. Esto es lo pedido y entregado hasta hoy:"),
          { type: "quantities", rows: d.materials.slice(0, 8).map((m) => ({ material: m.material, ordered: m.ordered, delivered: m.delivered, unit: m.unit })), computationPrompt: true },
        ];
      }
      const over = d.materials.filter((m) => m.status === "supera");
      const near = d.materials.filter((m) => m.status === "cerca" || m.status === "alcanzado");
      const without = d.materials.filter((m) => m.status === "sin_computo");
      const parts = [
        over.length ? over.map((m) => `${m.material} supera el cómputo (${m.percentOrdered}%, ${formatNumber(m.variance ?? 0)} ${m.unit} de más)`).join("; ") : "Ningún material supera el cómputo",
        near.length ? `${near.map((m) => `${m.material} (${m.percentOrdered}%)`).join(" y ")} ${near.length === 1 ? "está cerca" : "están cerca"}` : "",
      ].filter(Boolean);
      return [
        text(
          `Comparé lo pedido con el cómputo del ${formatDate(d.updatedAt!)}. ${parts.join("; ")}.${without.length ? ` ${without.length === 1 ? "Un material no tiene" : `${without.length} materiales no tienen`} cómputo.` : ""} Superar el cómputo es un aviso para revisar, no necesariamente un error.`,
        ),
        { type: "actions", actions: [{ label: "Ver materiales y cómputo", icon: "clipboard-list", link: { to: "/materiales" } }] },
      ];
    }
    case "search_materials": {
      const d = result.data;
      if (!d.candidates.length) return [text(`No encontré «${d.query}» en el catálogo de materiales.`)];
      return [text(`Encontré ${join(d.candidates.map((c) => c.name))}.`)];
    }
    case "get_material_order_summary":
    case "get_material_delivery_summary":
    case "get_material_history":
    case "get_computation_comparison": {
      const metric = question?.metric ?? MATERIAL_QUERY_METRIC[result.query] ?? "overview";
      return renderMaterialAnswer(ledger, materialFacts(ledger, result.data.materialId), { metric, unit: unitCodeFromWord(question?.unit, ledger.s.units) });
    }
    case "get_order_items": {
      const d = result.data;
      const lines = d.items.map((i) => `${i.quantity.text} de ${i.material}${i.unitSize ? ` (${i.unitSize.text} c/u)` : ""}${i.unitPriceMinor !== null ? ` a ${formatMoney(i.unitPriceMinor)}` : ""}`);
      return [
        text(`El pedido ${d.number} de ${d.supplier} tiene ${d.items.length === 1 ? "1 material" : `${d.items.length} materiales`}: ${lines.join("; ")}.${d.knownTotalMinor !== null ? ` Total: ${formatMoney(d.knownTotalMinor)}.` : ""}`),
        { type: "actions", actions: [{ label: `Ver pedido ${d.number}`, icon: "truck", link: { to: "/pedidos/$orderId", params: { orderId: d.orderId } } }] },
      ];
    }
    case "search_order_items": {
      const d = result.data;
      if (!d.items.length) return [text("No encontré líneas de pedido con esos filtros.")];
      return [text(d.items.map((i) => `Pedido ${i.number} (${formatDate(i.date)}): ${i.quantity.text} de ${i.material}, ${i.pending.quantity ? `faltan ${i.pending.text}` : "entregado"}`).join(" · "))];
    }
    case "list_unallocated_payments": {
      const d = result.data;
      if (!d.payments.length) return [text("No hay pagos sin imputar.")];
      return [
        text(
          `Pagos sin imputar: ${d.payments.map((p) => `${formatMoney(p.unallocatedMinor)} a ${p.supplier} (${formatDate(p.date)})`).join(" · ")}. Ya reducen el saldo del proveedor; puedes imputarlos a un pedido cuando sepas a cuál corresponden.`,
        ),
      ];
    }
  }
}

/** Ids a result is about, so a follow-up question can refer to them. */
export function refsOf(result: ProjectQueryResult): Partial<ContextRefs> {
  if (result.status !== "ok") return { orderIds: result.argument === "order" ? result.candidates.map((c) => c.id) : [] };
  switch (result.query) {
    case "get_supplier_summary":
      return { supplierIds: [result.data.supplierId] };
    case "get_order_summary":
      return { orderIds: [result.data.orderId], supplierIds: [result.data.supplierId] };
    case "get_material_summary":
    case "get_material_order_summary":
    case "get_material_delivery_summary":
    case "get_material_history":
    case "get_computation_comparison":
      return { materialIds: [result.data.materialId] };
    case "get_order_items":
      return { orderIds: [result.data.orderId], supplierIds: [result.data.supplierId] };
    case "list_orders_pending_delivery":
    case "list_delivered_unpaid_orders":
      return { orderIds: result.data.orders.map((o) => o.orderId) };
    default:
      return {};
  }
}

const FALLBACK = "Puedo responder sobre saldos con proveedores, entregas pendientes, cantidades pedidas y el cómputo. Prueba con «¿Cuánto debemos a Hierros Córdoba?».";

export async function answerQuestion(
  ledger: Ledger,
  q: ProjectQuestion,
  deps: { provider: AIProvider; conversation: ConversationState; question: string; today: string },
): Promise<AnswerResult> {
  const focus = deps.conversation.focus;
  const material = planMaterialQuestion(ledger, q, deps.question, focus);
  if (material) return answerMaterialQuestion(ledger, q, material);
  // "¿Y cuántas llegaron?" right after talking about one order.
  const metric = inferMetric(deps.question) ?? q.metric ?? null;
  if (q.query === "general" && focus.orderId && (metric === "delivered_quantity" || metric === "pending_delivery_quantity")) {
    const result = runProjectQuery(ledger, "get_order_summary", {}, { orderId: focus.orderId });
    return { blocks: renderQueryResult(ledger, result, { ...q, aspect: "delivery" }), refs: refsOf(result), results: [result] };
  }
  if (q.query === "general") {
    const results = [runProjectQuery(ledger, "list_supplier_balances", {}), runProjectQuery(ledger, "list_orders_pending_delivery", {}), runProjectQuery(ledger, "get_computation_variance", {})];
    try {
      const answer = await deps.provider.answer({ question: deps.question, today: deps.today, results, conversation: deps.conversation.context });
      return { blocks: [text(answer.text)], refs: {}, results };
    } catch (error) {
      if (!isAIError(error)) throw error;
      return { blocks: [text(FALLBACK)], refs: {}, results };
    }
  }
  // Follow-ups ("¿y cuánto falta pagar?") use the entity of the previous reply when the question names none.
  const refs: ResolvedRefs = {};
  const need = NEEDS[q.query];
  if (need === "order" && !q.orderReference && (q.refersToPrevious || focus.orderId) && focus.orderId) refs.orderId = focus.orderId;
  if (need === "supplier" && !q.supplier && focus.supplierId) refs.supplierId = focus.supplierId;
  if (need === "material" && !q.material && focus.materialId) refs.materialId = focus.materialId;
  if (q.query === "get_supplier_summary" && !q.supplier && !refs.supplierId) {
    // "¿Cuánto debemos?" without a supplier: the total.
    const total = runProjectQuery(ledger, "list_supplier_balances", {});
    return { blocks: renderQueryResult(ledger, total), refs: {}, results: [total] };
  }
  const result = runProjectQuery(ledger, q.query, { supplier: q.supplier, order: q.orderReference, material: q.material }, refs);
  return { blocks: renderQueryResult(ledger, result, q), refs: refsOf(result), results: [result] };
}

// ------------------------------------------------------------------ material questions

interface MaterialPlan {
  metric: MaterialMetric | "overview";
  /** Resolved material, or candidates to ask about. */
  materialId?: string;
  ask?: { mention: string | null; candidates: MatchOption[] };
  notFound?: string;
  unit: string | null;
  supplier: string | null;
  order: string | null;
}

/**
 * Decides, without the provider, whether a question is about one material and
 * which fact it asks. The provider's query is a hint: "¿cuántas barras del 12
 * se pidieron?" is a material question even if a model classified it as an
 * order summary. Follow-ups ("¿y cuántas llegaron?") reuse the material of
 * the previous reply; a vague mention with no context is asked back.
 */
export function planMaterialQuestion(ledger: Ledger, q: ProjectQuestion, question: string, focus: ConversationFocus): MaterialPlan | null {
  const inferred = inferMetric(question);
  const byQuery = q.query === "general" ? undefined : MATERIAL_QUERY_METRIC[q.query];
  const metric = inferred ?? q.metric ?? byQuery ?? null;
  const fromText = materialMentionIn(withoutSupplierNames(ledger, question));
  const said = q.material ?? fromText;
  const specific = said && !isGenericMaterialMention(said) ? said : null;
  const unit = unitCodeFromWord(q.unit, ledger.s.units) ?? inferRequestedUnit(question);
  const base = { unit, supplier: q.supplier, order: q.orderReference };
  const isMaterialQuery = byQuery !== undefined;
  if (!isMaterialQuery && (!REROUTABLE.has(q.query) || !metric)) return null;
  const finalMetric = metric ?? "overview";

  if (specific) {
    // Try the provider's mention first, then what the question itself names.
    const tries = [...new Set([specific, ...(fromText && fromText !== specific && !isGenericMaterialMention(fromText) ? [fromText] : [])])];
    let ambiguous: MatchOption[] | null = null;
    for (const mention of tries) {
      const r = resolveMaterial(ledger, mention);
      if (r.status === "ok") return { ...base, metric: finalMetric, materialId: r.value };
      if (r.status === "ambiguous" && !ambiguous) ambiguous = r.candidates;
    }
    if (ambiguous) {
      if (focus.materialId && ambiguous.some((c) => c.id === focus.materialId)) return { ...base, metric: finalMetric, materialId: focus.materialId };
      return { ...base, metric: finalMetric, ask: { mention: specific, candidates: ambiguous } };
    }
    // Names no catalog material: a material query says so; anything else keeps its own route.
    if (isMaterialQuery) return { ...base, metric: finalMetric, notFound: specific };
    if (!q.refersToPrevious || !focus.materialId) return null;
  }

  // No specific material named: the previous reply's material, when the question reads as a follow-up.
  const followUp = q.refersToPrevious || /^\s*[¿]?\s*(y|e)\b/i.test(question) || /\bcuant[oa]s?\b/.test(normalizeText(question));
  if (focus.materialId && (followUp || isMaterialQuery) && !q.orderReference && compatible(ledger, focus.materialId, said)) return { ...base, metric: finalMetric, materialId: focus.materialId };
  if (!metric || !isQuantityLike(metric)) return isMaterialQuery ? { ...base, metric: finalMetric, ask: { mention: said, candidates: [] } } : null;
  // "¿Cuántas barras se pidieron?" with nothing to go on: ask which one.
  if (said) {
    const candidates = genericCandidates(ledger, said);
    if (candidates.length === 1) return { ...base, metric: finalMetric, materialId: candidates[0]!.id };
    if (candidates.length) return { ...base, metric: finalMetric, ask: { mention: said, candidates } };
  }
  return isMaterialQuery ? { ...base, metric: finalMetric, ask: { mention: said, candidates: [] } } : null;
}

/** "…del pedido 38 de Hierros Córdoba": a supplier's name is not a material mention. */
function withoutSupplierNames(ledger: Ledger, question: string): string {
  let t = normalizeText(question);
  for (const s of ledger.s.suppliers) {
    for (const name of [s.name, ...safeJsonArray(s.aliases)]) {
      const n = normalizeText(name);
      if (n.length >= 4) t = t.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
    }
  }
  return t;
}

function isQuantityLike(m: MaterialMetric | "overview"): boolean {
  return m !== "overview" && (isQuantityMetric(m) || m === "ordered_amount" || m === "unit_price");
}

/** "barras" fits a material bought in bars; "hierro" fits steel. Anything else is not a conflict. */
function compatible(ledger: Ledger, materialId: string, mention: string | null): boolean {
  if (!mention) return true;
  const unit = unitCodeFromWord(mention.split(/\s+/)[0], ledger.s.units);
  if (!unit) return true;
  const m = ledger.material(materialId)!;
  return m.baseUnit === unit || ledger.s.orderItems.some((i) => i.materialId === materialId && i.unit === unit);
}

/** Materials a generic mention could mean: "barras"/"hierro" → bars in the catalog that have records. */
function genericCandidates(ledger: Ledger, mention: string): MatchOption[] {
  const unit = unitCodeFromWord(mention.split(/\s+/)[0], ledger.s.units);
  const steel = /\b(hierros?|aceros?|fierros?|varillas?|barras?)\b/.test(normalizeText(mention));
  const used = new Set([...ledger.s.orderItems.map((i) => i.materialId), ...ledger.s.computationItems.map((c) => c.materialId)]);
  return ledger.s.materials
    .filter((m) => used.has(m.id) && ((unit && m.baseUnit === unit) || (steel && steelSpec(m.name).bar && steelSpec(m.name).diameter)))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }))
    .map((m) => ({ id: m.id, name: m.name, unit: ledger.unitLabel(m.baseUnit) }));
}

const ASK_PROMPT: Record<MaterialMetric | "overview", (name: string) => string> = {
  ordered_quantity: (n) => `¿Cuánto se pidió de ${n}?`,
  delivered_quantity: (n) => `¿Cuánto llegó de ${n}?`,
  pending_delivery_quantity: (n) => `¿Cuánto falta que llegue de ${n}?`,
  expected_quantity: (n) => `¿Cuánto ${n} prevé el cómputo?`,
  remaining_to_order_quantity: (n) => `¿Cuánto falta pedir de ${n}?`,
  ordered_amount: (n) => `¿Cuánto salió ${n}?`,
  unit_price: (n) => `¿Cuánto costó cada unidad de ${n}?`,
  purchase_history: (n) => `¿Cuándo se pidió ${n}?`,
  overview: (n) => `¿Cuánto ${n} llevamos pedido?`,
};

const QUERY_FOR_METRIC: Record<MaterialMetric | "overview", ProjectQueryName> = {
  ordered_quantity: "get_material_order_summary",
  ordered_amount: "get_material_order_summary",
  unit_price: "get_material_order_summary",
  delivered_quantity: "get_material_delivery_summary",
  pending_delivery_quantity: "get_material_delivery_summary",
  expected_quantity: "get_computation_comparison",
  remaining_to_order_quantity: "get_computation_comparison",
  purchase_history: "get_material_history",
  overview: "get_material_order_summary",
};

function answerMaterialQuestion(ledger: Ledger, q: ProjectQuestion, plan: MaterialPlan): AnswerResult {
  const query = QUERY_FOR_METRIC[plan.metric];
  if (plan.notFound) {
    return { blocks: [text(`No encontré «${plan.notFound}» en el catálogo de materiales.`)], refs: {}, results: [{ query, status: "not_found", argument: "material", mention: plan.notFound, candidates: [] }] };
  }
  if (plan.ask) {
    const { candidates } = plan.ask;
    const result: ProjectQueryResult = { query, status: candidates.length ? "ambiguous" : "missing_argument", argument: "material", mention: plan.ask.mention, candidates };
    if (!candidates.length) return { blocks: [text("¿De qué material? Por ejemplo «¿Cuántas barras del 12 se pidieron?».")], refs: {}, results: [result] };
    const steel = candidates.every((c) => steelSpec(c.name).diameter);
    return {
      blocks: [
        text(steel ? `¿De qué diámetro? Hay ${join(candidates.map((c) => c.name))}.` : `¿Te refieres a ${join(candidates.map((c) => c.name), "o")}?`),
        { type: "actions", actions: candidates.slice(0, 4).map((c) => ({ label: c.name, icon: "clipboard-list" as const, prompt: ASK_PROMPT[plan.metric](c.name) })) },
      ],
      refs: {},
      results: [result],
    };
  }
  const args = { material: "-", supplier: plan.supplier, order: plan.order };
  const result = runProjectQuery(ledger, query, args, { materialId: plan.materialId });
  if (result.status !== "ok") return { blocks: renderQueryResult(ledger, result, q), refs: refsOf(result), results: [result] };
  const filter: { orderNumber?: string; supplier?: string } = {};
  const facts = materialFacts(ledger, plan.materialId!, scopeOf(ledger, plan));
  if (plan.order) filter.orderNumber = facts.lines[0]?.orderNumber ?? plan.order;
  else if (plan.supplier) filter.supplier = facts.lines[0]?.supplier ?? plan.supplier;
  return { blocks: renderMaterialAnswer(ledger, facts, { metric: plan.metric, unit: plan.unit, filter }), refs: { materialIds: [plan.materialId!] }, results: [result] };
}

function scopeOf(ledger: Ledger, plan: MaterialPlan): MaterialFilter {
  const supplier = plan.supplier ? resolveSupplier(ledger, plan.supplier) : null;
  const supplierId = supplier?.status === "ok" ? supplier.value : undefined;
  if (plan.order) {
    const r = resolveOrderReference(ledger, plan.order, supplierId);
    if (r.status === "ok") return { orderId: r.value.id };
  }
  return supplierId ? { supplierId } : {};
}

function join(parts: string[], last = "y"): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} ${last} ${parts.at(-1)}`;
}
