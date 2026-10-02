import type { AssistantBlock } from "../../src/domain/assistant";
import { formatDate, formatMoney, formatNumber } from "../../src/domain/format";
import type { Ledger } from "../domain/derive";
import { findOrdersByReference, matchMaterial } from "../domain/matching";
import type { AIProvider } from "./provider";
import { materialCandidates, resolveSupplierMention } from "./proposals";
import type { Extraction } from "./schemas";

// Read-only questions are answered from persisted records. The AI only
// classifies the question; balances and quantities are computed here.

function text(t: string): AssistantBlock {
  return { type: "text", text: t };
}

function supplierBalance(ledger: Ledger, supplierId: string): AssistantBlock[] {
  const supplier = ledger.supplier(supplierId)!;
  const detail = ledger.toSupplierDetail(supplier);
  const blocks: AssistantBlock[] = [
    text(`Hoy el saldo con ${supplier.name} es de ${formatMoney(detail.balance)}${detail.unknownValueOrders ? " según los importes conocidos" : ""}.`),
    {
      type: "balance",
      supplierId,
      ordered: detail.totalOrdered,
      paid: detail.totalPaid,
      balance: detail.balance,
      allocatedPaid: detail.allocatedPaid,
      unallocatedPaid: detail.unallocatedPaid,
      rows: [
        ...detail.openOrderList
          .filter((o) => (o.pendingPayment ?? 0) > 0 || o.total === null)
          .map((o) => ({
            label: `Pedido ${o.number}`,
            description: o.total === null ? "Importe a confirmar" : o.payment.status === "parcial" ? `Pago parcial · pagado ${formatMoney(o.paid)}` : "Sin pagos",
            amount: o.pendingPayment ?? 0,
            orderId: o.id,
          })),
        ...detail.unallocatedPayments.map((p) => ({
          label: "Sin imputar",
          description: `Pago del ${formatDate(p.date).slice(0, 5)}`,
          amount: -p.unallocatedAmount,
          unallocated: true,
        })),
      ],
    },
  ];
  if (detail.unknownValueOrders) {
    blocks.push({
      type: "note",
      text: `${detail.unknownValueOrders === 1 ? "Hay 1 pedido" : `Hay ${detail.unknownValueOrders} pedidos`} sin importe cargado: el saldo real puede ser mayor. Completa los precios en el pedido para tener el total exacto.`,
    });
  }
  if (detail.unallocatedPaid > 0) {
    blocks.push(text(`${formatMoney(detail.unallocatedPaid)} de pagos todavía no están asignados a un pedido, pero ya reducen el saldo. ¿Quieres imputarlos?`), {
      type: "actions",
      actions: [
        { label: "Imputar el pago", icon: "git-fork", prompt: `Imputar el pago sin imputar de ${supplier.name}` },
        { label: "Ver cuenta corriente", icon: "store", link: { to: "/proveedores/$supplierId", params: { supplierId } } },
      ],
    });
  }
  return blocks;
}

function totalBalance(ledger: Ledger): AssistantBlock[] {
  const overview = ledger.suppliersOverview();
  const withBalance = overview.suppliers.filter((s) => s.balance !== 0 || s.unknownValueOrders);
  if (!withBalance.length) return [text("Hoy no hay saldos pendientes con proveedores.")];
  const unknown = overview.suppliers.reduce((s, x) => s + x.unknownValueOrders, 0);
  return [
    text(
      `El saldo total con proveedores es de ${formatMoney(overview.totalBalance)}. ${withBalance
        .map((s) => `${s.name}: ${formatMoney(s.balance)}${s.unknownValueOrders ? ` (+${s.unknownValueOrders} sin importe)` : ""}`)
        .join(" · ")}.`,
    ),
    ...(unknown ? [{ type: "note" as const, text: `${unknown === 1 ? "Un pedido no tiene" : `${unknown} pedidos no tienen`} importe cargado y no suman al total.` }] : []),
  ];
}

function pendingDeliveries(ledger: Ledger, supplierId?: string | null): AssistantBlock[] {
  const open = ledger.s.orders
    .filter((o) => (!supplierId || o.supplierId === supplierId) && ledger.orderDeliveryStatus(o) !== "entregado")
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
  if (!open.length) return [text(supplierId ? `No hay pedidos de ${ledger.supplierName(supplierId)} pendientes de entrega.` : "No hay pedidos pendientes de entrega. Todo lo pedido ya llegó.")];
  return [
    text(open.length === 1 ? "Hay 1 pedido pendiente de entrega:" : `Hay ${open.length} pedidos pendientes de entrega:`),
    {
      type: "pending_deliveries",
      rows: open.map((o) => {
        const s = ledger.toOrderSummary(o);
        return {
          orderId: o.id,
          orderNumber: s.number,
          supplier: s.supplier.name,
          pendingLabel: s.delivery.status === "pendiente" ? `Nada entregado · ${s.delivery.pendingLabel?.replace(/^Faltan /, "") ?? ""}` : s.delivery.pendingLabel ?? "Entrega parcial",
        };
      }),
    },
  ];
}

function materialQuantity(ledger: Ledger, mention: string | null): AssistantBlock[] {
  if (!mention) return [text("¿De qué material quieres saber la cantidad?")];
  const match = matchMaterial(mention, materialCandidates(ledger));
  if (match.status === "new") return [text(`No encontré «${mention}» en el catálogo de materiales.`)];
  if (match.status === "suggested") {
    return [
      text(`¿Te refieres a ${match.candidates.map((c) => c.item.name).join(" o ")}?`),
      { type: "actions", actions: match.candidates.map((c) => ({ label: c.item.name, icon: "clipboard-list" as const, prompt: `¿Cuánto ${c.item.name} llevamos pedido?` })) },
    ];
  }
  const material = ledger.material(match.best!.id)!;
  const summary = ledger.toMaterialSummary(material);
  const unit = summary.unit;
  const c = summary.computation;
  const parts = [`Llevamos pedido ${formatNumber(summary.ordered)} ${unit} de ${material.name}`, `${formatNumber(summary.delivered)} ${unit} entregadas`];
  if (summary.pendingDelivery) parts.push(`${formatNumber(summary.pendingDelivery)} pendientes de entrega`);
  let computationText = "";
  if (c) {
    computationText =
      c.status === "supera"
        ? ` Supera el cómputo (${formatNumber(c.expected)} ${unit}) en ${formatNumber(c.variation)} ${unit}: conviene revisarlo.`
        : ` Es el ${c.percent}% del cómputo (${formatNumber(c.expected)} ${unit}); quedan ${formatNumber(c.remaining)} ${unit} por pedir.`;
  } else computationText = " Este material todavía no tiene cómputo para comparar.";
  return [
    text(`${parts.join(", ")}.${computationText}`),
    {
      type: "quantities",
      rows: [{ material: material.name, ordered: summary.ordered, delivered: summary.delivered, unit }],
      computationPrompt: !ledger.computationInfo().loaded,
    },
    { type: "actions", actions: [{ label: "Ver material", icon: "clipboard-list", link: { to: "/materiales" } }] },
  ];
}

function computationStatus(ledger: Ledger): AssistantBlock[] {
  const overview = ledger.materialsOverview();
  if (!overview.materials.length) return [text("Todavía no hay materiales registrados. Cuando registres el primer pedido podré compararlo con el cómputo.")];
  if (!overview.computation.loaded) {
    return [
      text("Aún no hay un cómputo cargado, así que no puedo compararlo. Esto es lo pedido y entregado hasta hoy:"),
      { type: "quantities", rows: overview.materials.slice(0, 8).map((m) => ({ material: m.name, ordered: m.ordered, delivered: m.delivered, unit: m.unit })), computationPrompt: true },
    ];
  }
  const over = overview.materials.filter((m) => m.computation?.status === "supera");
  const near = overview.materials.filter((m) => m.computation?.status === "cerca" || m.computation?.status === "alcanzado");
  const without = overview.materials.filter((m) => !m.computation);
  const parts = [
    over.length ? over.map((m) => `${m.name} supera el cómputo (${m.computation!.percent}%, ${formatNumber(m.computation!.variation)} ${m.unit} de más)`).join("; ") : "Ningún material supera el cómputo",
    near.length ? `${near.map((m) => `${m.name} (${m.computation!.percent}%)`).join(" y ")} ${near.length === 1 ? "está cerca" : "están cerca"}` : "",
  ].filter(Boolean);
  return [
    text(
      `Comparé lo pedido con el cómputo del ${formatDate(overview.computation.updatedAt!)}. ${parts.join("; ")}.${without.length ? ` ${without.length === 1 ? "Un material no tiene" : `${without.length} materiales no tienen`} cómputo.` : ""} Superar el cómputo es un aviso para revisar, no necesariamente un error.`,
    ),
    { type: "actions", actions: [{ label: "Ver materiales y cómputo", icon: "clipboard-list", link: { to: "/materiales" } }] },
  ];
}

function orderStatus(ledger: Ledger, ref: string | null): AssistantBlock[] {
  if (!ref) return [text("¿De qué pedido?")];
  const found = findOrdersByReference(ref, ledger.s.orders);
  if (!found.length) return [text(`No encontré el pedido ${ref}.`)];
  return found.map((o) => {
    const s = ledger.toOrderSummary(o);
    const delivery = { pendiente: "pendiente de entrega", parcial: `con entrega parcial (${s.delivery.pendingLabel?.toLowerCase() ?? ""})`, entregado: "entregado completo" }[s.delivery.status];
    const payment = s.total === null ? `sin importe cargado (pagado ${formatMoney(s.payment.paid)})` : s.payment.status === "pagado" ? "pagado" : `con saldo de ${formatMoney(s.pendingPayment ?? 0)} de ${formatMoney(s.total)}`;
    return text(`El pedido ${s.number} de ${s.supplier.name} (${formatDate(s.date)}) está ${delivery} y ${payment}.`);
  });
}

function unallocatedPayments(ledger: Ledger, supplierId?: string | null): AssistantBlock[] {
  const rows = ledger.s.payments.filter((p) => (!supplierId || p.supplierId === supplierId) && ledger.paymentUnallocated(p) > 0);
  if (!rows.length) return [text("No hay pagos sin imputar.")];
  return [text(`Pagos sin imputar: ${rows.map((p) => `${formatMoney(ledger.paymentUnallocated(p))} a ${ledger.supplierName(p.supplierId)} (${formatDate(p.paymentDate)})`).join(" · ")}. Ya reducen el saldo del proveedor; puedes imputarlos a un pedido cuando sepas a cuál corresponden.`)];
}

/** Short summary of verified figures for free-form questions. */
export function factsFor(ledger: Ledger): string {
  const sup = ledger.suppliersOverview();
  const orders = ledger.ordersOverview();
  const mats = ledger.materialsOverview();
  return [
    `Saldo total con proveedores: ${formatMoney(sup.totalBalance)}.`,
    ...sup.suppliers.map((s) => `${s.name}: pedidos ${formatMoney(s.totalOrdered)}${s.unknownValueOrders ? ` (+${s.unknownValueOrders} sin importe)` : ""}, pagado ${formatMoney(s.totalPaid)}, saldo ${formatMoney(s.balance)}, sin imputar ${formatMoney(s.unallocatedPaid)}.`),
    `Pedidos: ${orders.orders.length}; pendientes de entrega: ${orders.pendingDeliveryLabel}.`,
    `Cómputo: ${mats.computation.loaded ? `cargado (v${mats.computation.version})` : "sin cargar"}.`,
    ...mats.materials.map((m) => `${m.name}: pedido ${formatNumber(m.ordered)} ${m.unit}, entregado ${formatNumber(m.delivered)}${m.computation ? `, cómputo ${formatNumber(m.computation.expected)} (${m.computation.percent}%)` : ""}.`),
  ].join("\n");
}

export async function answerQuery(ledger: Ledger, ex: Extraction, provider: AIProvider, question: string, today: string): Promise<AssistantBlock[]> {
  const q = ex.query ?? { type: "general" as const, supplier: ex.supplier, material: null, orderReference: ex.orderReference };
  const supplier = q.supplier ? resolveSupplierMention(ledger, q.supplier) : null;
  const supplierId = supplier && supplier.status !== "new" ? supplier.id : null;
  switch (q.type) {
    case "supplier_balance":
      if (supplierId) return supplierBalance(ledger, supplierId);
      return q.supplier ? [text(`No encontré a «${q.supplier}» entre los proveedores.`), ...totalBalance(ledger)] : totalBalance(ledger);
    case "total_balance":
      return totalBalance(ledger);
    case "pending_deliveries":
      return pendingDeliveries(ledger, supplierId);
    case "material_quantity":
      return materialQuantity(ledger, q.material);
    case "computation_status":
      return computationStatus(ledger);
    case "order_status":
      return orderStatus(ledger, q.orderReference);
    case "unallocated_payments":
      return unallocatedPayments(ledger, supplierId);
    default: {
      try {
        const answer = await provider.answer({ question, today, facts: factsFor(ledger) });
        return [text(answer.text)];
      } catch {
        return [text("Puedo responder sobre saldos con proveedores, entregas pendientes, cantidades pedidas y el cómputo. Prueba con «¿Cuánto debemos a Hierros Córdoba?».")];
      }
    }
  }
}
