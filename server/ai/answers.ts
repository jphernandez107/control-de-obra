import type { AssistantBlock, BalanceRow } from "../../src/domain/assistant";
import { formatDate, formatMoney, formatNumber } from "../../src/domain/format";
import type { Ledger } from "../domain/derive";
import type { ContextRefs, ConversationState } from "./conversation-context";
import { isAIError } from "./errors";
import { runProjectQuery, type ProjectQueryResult, type ProjectQueryUnresolved, type ResolvedRefs } from "./project-queries";
import type { AIProvider } from "./provider";
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
  get_material_summary: "material",
};

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
      return { materialIds: [result.data.materialId] };
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
