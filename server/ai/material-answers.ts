import type { AssistantBlock } from "../../src/domain/assistant";
import { formatDate, formatMoney, formatNumber } from "../../src/domain/format";
import type { Ledger } from "../domain/derive";
import type { MaterialFacts, MaterialLineFact, Qty } from "../domain/summaries";
import type { MaterialMetric } from "./question-semantics";

// Deterministic answers to material questions. The figures come from
// `materialFacts` (persisted order lines, deliveries and computation); the
// sentence starts with the exact fact asked — quantity, unit, material — and
// context follows only when it helps. No provider writes these numbers.

const FEMININE_UNITS = new Set(["barra", "bolsa", "malla", "unidad"]);

function text(t: string): AssistantBlock {
  return { type: "text", text: t };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function join(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}`;
}

/** "172 barras", "2.064 m lineales", "172 barras y 50 m" (never summed across units). */
function qtyText(ledger: Ledger, q: Qty | Qty[], lineal = false): string {
  const list = Array.isArray(q) ? q : [q];
  return join(list.map((x) => `${ledger.quantityText(x.milli, x.unit)}${lineal && x.unit === "m" ? " lineales" : ""}`));
}

function total(q: Qty[]): number {
  return q.reduce((s, x) => s + x.milli, 0);
}

function feminine(unit: string): boolean {
  return FEMININE_UNITS.has(unit);
}

/** Sum of a per-line figure expressed in `unit`, or null if any line cannot be converted. */
function sumIn(ledger: Ledger, f: MaterialFacts, pick: (l: MaterialLineFact) => number, unit: string): number | null {
  let sum = 0;
  for (const l of f.lines) {
    const item = ledger.orderItem(l.orderItemId);
    const v = item ? ledger.lineQuantityIn(item, pick(l), unit) : null;
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

/** "de 12 m cada una" when every line shares the purchase size. */
function sizePhrase(ledger: Ledger, f: MaterialFacts): string {
  if (!f.unitSize) return "";
  return ` de ${ledger.quantityText(f.unitSize.milli, f.unitSize.unit)} cada ${feminine(f.lines[0]!.unit) ? "una" : "uno"}`;
}

/** "el pedido #1 de Hierros Córdoba" / "los pedidos 352 y 381" (without the article inside parentheses). */
function ordersPhrase(lines: { orderNumber: string; supplier: string }[], article = true): string {
  const orders = [...new Map(lines.map((l) => [l.orderNumber, l])).values()];
  if (orders.length === 1) return `${article ? "el " : ""}pedido ${orders[0]!.orderNumber} de ${orders[0]!.supplier}`;
  const suppliers = new Set(orders.map((o) => o.supplier));
  return `${article ? "los " : ""}pedidos ${join(orders.map((o) => o.orderNumber))}${suppliers.size === 1 ? ` de ${orders[0]!.supplier}` : ""}`;
}

function scope(filter: { orderNumber?: string; supplier?: string }): string {
  if (filter.orderNumber) return ` en el pedido ${filter.orderNumber}`;
  if (filter.supplier) return ` a ${filter.supplier}`;
  return "";
}

function noOrders(f: MaterialFacts, filter: { orderNumber?: string; supplier?: string }): AssistantBlock[] {
  const where = scope(filter);
  return [text(where ? `No hay pedidos de ${f.material}${where}.` : `Todavía no hay pedidos de ${f.material} registrados.`)];
}

function materialLink(f: MaterialFacts): AssistantBlock {
  return { type: "actions", actions: [{ label: `Ver ${f.material}`, icon: "clipboard-list", link: { to: "/materiales/$materialId", params: { materialId: f.materialId } } }] };
}

const UNIT_NAMES: Record<string, string> = { m: "metros", kg: "kilos", barra: "barras", bolsa: "bolsas", m3: "m³", m2: "m²", malla: "mallas", unidad: "unidades", l: "litros" };

export interface MaterialAnswerOptions {
  metric: MaterialMetric | "overview";
  /** Unit the user asked for ("metros lineales" → m); converted deterministically when possible. */
  unit?: string | null;
  filter?: { orderNumber?: string; supplier?: string };
}

export function renderMaterialAnswer(ledger: Ledger, f: MaterialFacts, options: MaterialAnswerOptions): AssistantBlock[] {
  const filter = options.filter ?? {};
  const asked = options.unit && options.unit !== f.baseUnit && ledger.unitInfo(options.unit) ? options.unit : null;
  const name = f.material;
  const ordered = qtyText(ledger, f.ordered);
  const plural = total(f.ordered) !== 1000 || f.ordered.length > 1;
  const unit0 = f.lines[0]?.unit ?? f.baseUnit;
  const converted = (pick: (l: MaterialLineFact) => number) => (asked ? sumIn(ledger, f, pick, asked) : null);
  const cannotConvert = asked ? `No tengo cómo expresar ${name} en ${UNIT_NAMES[asked] ?? asked}. ` : "";

  switch (options.metric) {
    case "ordered_quantity": {
      if (!f.lines.length) return noOrders(f, filter);
      const inAsked = converted((l) => l.quantityMilli);
      let lead: string;
      if (inAsked !== null) lead = `Se ${inAsked === 1000 ? "pidió" : "pidieron"} ${qtyText(ledger, { milli: inAsked, unit: asked! }, true)} de ${name}${scope(filter)} (${ordered}${sizePhrase(ledger, f)}).`;
      else {
        lead = `${cannotConvert}Se ${plural ? "pidieron" : "pidió"} ${ordered} de ${name}${sizePhrase(ledger, f)}${scope(filter)}.`;
        if (f.equivalent && !f.ordered.some((q) => q.unit === f.equivalent!.unit)) lead += ` ${plural ? "Equivalen" : "Equivale"} a ${qtyText(ledger, f.equivalent, true)}.`;
      }
      const where = filter.orderNumber ? "" : ` ${plural ? "Figuran" : "Figura"} en ${ordersPhrase(f.lines)}${new Set(f.lines.map((l) => l.orderId)).size === 1 ? ` (${formatDate(f.lines[0]!.date)})` : ""}.`;
      return [text(`${lead}${where}`), materialLink(f)];
    }

    case "delivered_quantity": {
      if (!f.lines.length) return noOrders(f, filter);
      const delivered = total(f.delivered);
      const pending = total(f.pendingDelivery);
      const inAsked = converted((l) => l.deliveredMilli);
      const pendingAsked = converted((l) => l.remainingMilli);
      const d = inAsked !== null ? qtyText(ledger, { milli: inAsked, unit: asked! }, true) : qtyText(ledger, f.delivered);
      const p = pendingAsked !== null ? qtyText(ledger, { milli: pendingAsked, unit: asked! }, true) : qtyText(ledger, f.pendingDelivery);
      let lead: string;
      if (delivered === 0) {
        const none = feminine(unit0) ? `ninguna ${ledger.unitInfo(unit0)?.singular ?? ""}`.trim() : "nada";
        lead = `Todavía no llegó ${none} de ${name}${scope(filter)}. Hay ${p} pendientes de entrega.`;
      } else if (pending === 0) lead = `Llegaron ${d} de ${name}${scope(filter)}: está todo entregado.`;
      else if (inAsked === null && f.delivered.length === 1 && f.ordered.length === 1 && f.delivered[0]!.unit === f.ordered[0]!.unit)
        lead = `Llegaron ${formatNumber(delivered / 1000)} de ${feminine(f.ordered[0]!.unit) ? "las" : "los"} ${ordered} de ${name}${scope(filter)}. Faltan ${p}.`;
      else lead = `Llegaron ${d} de ${name}${scope(filter)} (se pidieron ${ordered}). Faltan ${p}.`;
      const last = f.deliveries.at(-1);
      if (last) lead += ` La última entrega fue el ${formatDate(last.date)}${last.reference ? ` (remito ${last.reference})` : ""}.`;
      return [text(lead), materialLink(f)];
    }

    case "pending_delivery_quantity": {
      if (!f.lines.length) return noOrders(f, filter);
      const pending = total(f.pendingDelivery);
      const pendingAsked = converted((l) => l.remainingMilli);
      const p = pendingAsked !== null ? qtyText(ledger, { milli: pendingAsked, unit: asked! }, true) : qtyText(ledger, f.pendingDelivery);
      if (pending === 0) return [text(`No falta entregar nada de ${name}${scope(filter)}: llegó todo lo pedido (${ordered}).`), materialLink(f)];
      const open = f.lines.filter((l) => l.remainingMilli > 0);
      const delivered = total(f.delivered);
      return [
        text(
          `Faltan entregar ${p} de ${name}${scope(filter)}${delivered === 0 ? ": todavía no llegó nada" : ` (llegaron ${qtyText(ledger, f.delivered)} de ${ordered})`}. ${capitalize(open.length === 1 ? "está pendiente en " : "están pendientes en ")}${ordersPhrase(open)}.`,
        ),
        materialLink(f),
      ];
    }

    case "expected_quantity": {
      const c = f.computation;
      if (!c) return [text(`${name} no tiene cómputo cargado, así que no sé cuánto se necesita.${f.lines.length ? ` Hasta ahora se ${plural ? "pidieron" : "pidió"} ${ordered}.` : ""}`), materialLink(f)];
      const expAsked = asked ? ledger.convertForMaterial(f.materialId, c.expectedMilli, f.baseUnit, asked) : null;
      const exp = expAsked !== null ? qtyText(ledger, { milli: expAsked, unit: asked! }, true) : qtyText(ledger, { milli: c.expectedMilli, unit: f.baseUnit });
      const waste = c.wasteBasisPoints ? ` (incluye ${c.wasteBasisPoints / 100}% de desperdicio)` : "";
      return [text(`El cómputo prevé ${exp} de ${name}${waste}. Se ${plural ? "pidieron" : "pidió"} ${qtyText(ledger, { milli: c.orderedMilli, unit: f.baseUnit })} (${c.percent}%).`), materialLink(f)];
    }

    case "remaining_to_order_quantity": {
      const c = f.computation;
      if (!c) return [text(`No puedo calcular cuánto falta pedir de ${name}: no tiene cómputo cargado.${f.lines.length ? ` Hasta ahora se ${plural ? "pidieron" : "pidió"} ${ordered}.` : ""}`), materialLink(f)];
      const exp = qtyText(ledger, { milli: c.expectedMilli, unit: f.baseUnit });
      const orderedBase = qtyText(ledger, { milli: c.orderedMilli, unit: f.baseUnit });
      if (c.remainingToOrderMilli > 0) {
        const remAsked = asked ? ledger.convertForMaterial(f.materialId, c.remainingToOrderMilli, f.baseUnit, asked) : null;
        const rem = remAsked !== null ? qtyText(ledger, { milli: remAsked, unit: asked! }, true) : qtyText(ledger, { milli: c.remainingToOrderMilli, unit: f.baseUnit });
        return [text(`Falta pedir ${rem} de ${name}: el cómputo prevé ${exp} y se pidieron ${orderedBase}.`), materialLink(f)];
      }
      if (c.overMilli > 0) return [text(`No falta pedir ${name}: se pidieron ${orderedBase}, ${qtyText(ledger, { milli: c.overMilli, unit: f.baseUnit })} más que el cómputo (${exp}). Conviene revisarlo.`), materialLink(f)];
      return [text(`No falta pedir ${name}: lo pedido (${orderedBase}) iguala el cómputo.`), materialLink(f)];
    }

    case "ordered_amount": {
      if (!f.lines.length) return noOrders(f, filter);
      const { knownMinor, pricedLines, unpricedLines } = f.amount;
      if (!pricedLines) return [text(`${name} no tiene precio cargado en ${ordersPhrase(f.lines)}, así que no sé cuánto salió. Puedes completar el precio en el pedido.`), materialLink(f)];
      const priced = f.lines.filter((l) => l.lineTotalMinor !== null);
      const detail =
        priced.length === 1
          ? `: ${qtyText(ledger, { milli: priced[0]!.quantityMilli, unit: priced[0]!.unit })} a ${formatMoney(priced[0]!.unitPriceMinor ?? 0)} cada ${feminine(priced[0]!.unit) ? "una" : "uno"} (${ordersPhrase(priced, false)})`
          : ` en ${ordersPhrase(priced)}`;
      const unknown = unpricedLines ? ` ${unpricedLines === 1 ? "Una línea no tiene" : `${unpricedLines} líneas no tienen`} precio cargado y no está${unpricedLines === 1 ? "" : "n"} incluida${unpricedLines === 1 ? "" : "s"}.` : "";
      return [text(`${name} salió ${formatMoney(knownMinor)}${scope(filter)}${detail}.${unknown}`), materialLink(f)];
    }

    case "unit_price": {
      if (!f.lines.length) return noOrders(f, filter);
      const priced = f.lines.filter((l) => l.unitPriceMinor !== null);
      if (!priced.length) return [text(`No hay precio cargado para ${name}${scope(filter)}.`), materialLink(f)];
      const per = (l: MaterialLineFact) => {
        const u = ledger.unitInfo(l.unit);
        return u && (u.label.length <= 3 || /[²³]/.test(u.label)) && l.unit !== "unidad" ? u.label : u?.singular ?? l.unit;
      };
      const prices = new Set(priced.map((l) => `${l.unitPriceMinor}:${l.unit}`));
      if (prices.size === 1) {
        const l = priced[0]!;
        const article = feminine(l.unit) ? "Cada" : "El";
        return [text(`${article} ${per(l)} de ${name} costó ${formatMoney(l.unitPriceMinor!)} (${ordersPhrase(priced, false)}).`), materialLink(f)];
      }
      return [text(`${name} se pagó a distintos precios: ${join(priced.map((l) => `${formatMoney(l.unitPriceMinor!)} por ${per(l)} en el pedido ${l.orderNumber} (${formatDate(l.date)})`))}.`), materialLink(f)];
    }

    case "purchase_history": {
      if (!f.lines.length) return noOrders(f, filter);
      const rows = f.lines.map((l) => `${formatDate(l.date)} · pedido ${l.orderNumber} de ${l.supplier}: ${qtyText(ledger, { milli: l.quantityMilli, unit: l.unit })}${l.unitPriceMinor !== null ? ` a ${formatMoney(l.unitPriceMinor)}` : ""}`);
      return [text(`${name} se pidió ${f.lines.length === 1 ? "una vez" : `${f.lines.length} veces`}: ${rows.join("; ")}.`), materialLink(f)];
    }

    case "overview": {
      if (!f.lines.length && !f.computation) return noOrders(f, filter);
      const parts = [f.lines.length ? `Se ${plural ? "pidieron" : "pidió"} ${ordered} de ${name}${sizePhrase(ledger, f)}` : `Todavía no se pidió ${name}`];
      if (f.lines.length) parts.push(total(f.delivered) === 0 ? "todavía no llegó nada" : total(f.pendingDelivery) === 0 ? "llegó todo" : `llegaron ${qtyText(ledger, f.delivered)} y faltan ${qtyText(ledger, f.pendingDelivery)}`);
      const c = f.computation;
      const comp = !c
        ? " Este material todavía no tiene cómputo para comparar."
        : c.overMilli > 0
          ? ` Supera el cómputo (${qtyText(ledger, { milli: c.expectedMilli, unit: f.baseUnit })}) en ${qtyText(ledger, { milli: c.overMilli, unit: f.baseUnit })}: conviene revisarlo.`
          : ` Es el ${c.percent}% del cómputo (${qtyText(ledger, { milli: c.expectedMilli, unit: f.baseUnit })}); quedan ${qtyText(ledger, { milli: c.remainingToOrderMilli, unit: f.baseUnit })} por pedir.`;
      const blocks: AssistantBlock[] = [text(`${parts.join(", ")}.${comp}`)];
      if (f.ordered.length === 1 && f.ordered[0]!.unit === f.baseUnit) {
        blocks.push({ type: "quantities", rows: [{ material: name, ordered: f.ordered[0]!.milli / 1000, delivered: total(f.delivered.filter((d) => d.unit === f.baseUnit)) / 1000, unit: ledger.unitLabel(f.baseUnit) }], computationPrompt: !ledger.computationInfo().loaded });
      }
      blocks.push(materialLink(f));
      return blocks;
    }
  }
}
