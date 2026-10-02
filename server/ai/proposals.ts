import type {
  AssistantBlock,
  Attachment,
  DeliveryInterpretation,
  InterpretedDeliveryItem,
  InterpretedOrderItem,
  MatchOption,
  OrderInterpretation,
  PaymentInterpretation,
} from "../../src/domain/assistant";
import type { StatusTag } from "../../src/domain/types";
import { formatDate, formatMoney, formatNumber } from "../../src/domain/format";
import type { Ledger } from "../domain/derive";
import { findOrdersByReference, matchMaterial, matchSupplier, type MaterialCandidate, type SupplierCandidate } from "../domain/matching";
import { parseMoneyToMinor } from "../domain/money";
import { fromMilli, toMilli } from "../domain/quantity";
import { normalizeText } from "../domain/text";
import { isValidDate } from "../domain/time";
import { unitCodeFromWord } from "../domain/units";
import type { Order } from "../repositories/snapshot";
import type { Extraction } from "./schemas";

// Turns a validated extraction into application-owned proposals. All
// matching (supplier, material, order) and every figure (remaining
// quantities, balances) is computed here from persisted records — never
// taken from the model. Proposals are only shown; nothing is written.

export interface Proposal {
  id: string;
  intent: string;
  interpretation: OrderInterpretation | DeliveryInterpretation | PaymentInterpretation;
}

export interface ProposalResult {
  blocks: AssistantBlock[];
  proposals: Proposal[];
}

const newId = () => crypto.randomUUID();

export function supplierCandidates(ledger: Ledger): (SupplierCandidate & { category: string })[] {
  return ledger.s.suppliers.map((s) => ({ id: s.id, name: s.name, aliases: safeJsonArray(s.aliases), category: s.category }));
}

export function materialCandidates(ledger: Ledger): MaterialCandidate[] {
  return ledger.s.materials.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, shortName: m.shortName, aliases: ledger.materialAliases(m.id), baseUnit: m.baseUnit }));
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((w, i) => (i > 0 && ["de", "del", "la", "las", "los", "y", "el"].includes(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function text(t: string): AssistantBlock {
  return { type: "text", text: t };
}

function dateOr(value: string | null, today: string): string {
  return value && isValidDate(value) ? value : today;
}

export function resolveSupplierMention(ledger: Ledger, mention: string | null) {
  if (!mention) return { status: "new" as const, id: null as string | null, name: "", candidates: [] as MatchOption[] };
  const result = matchSupplier(mention, supplierCandidates(ledger));
  return {
    status: result.status,
    id: result.status === "new" ? null : result.best!.id,
    name: result.status === "new" ? titleCase(mention) : result.best!.name,
    candidates: result.candidates.map((c) => ({ id: c.item.id, name: c.item.name })),
  };
}

// ------------------------------------------------------------------ orders

export function proposeOrder(ledger: Ledger, ex: Extraction, today: string, document?: Attachment): ProposalResult {
  const materials = materialCandidates(ledger);
  const flags: string[] = [];
  const items: InterpretedOrderItem[] = ex.items
    .filter((it) => it.quantity !== null && it.quantity > 0)
    .map((it, idx) => {
      const match = matchMaterial(it.material, materials);
      const explicitUnit = unitCodeFromWord(it.unit, ledger.s.units);
      const material = match.status === "new" ? undefined : match.best!;
      const unitCode = material ? (explicitUnit && explicitUnit !== material.baseUnit && ledger.inBaseUnit(material.id, 1000, explicitUnit) !== null ? explicitUnit : material.baseUnit) : explicitUnit ?? "unidad";
      return {
        id: `item-${idx + 1}`,
        materialId: material?.id ?? null,
        material: material?.name ?? titleCase(it.material),
        mention: it.material,
        match: match.status,
        candidates: match.status === "matched" ? undefined : match.candidates.map((c) => ({ id: c.item.id, name: c.item.name, unit: ledger.unitLabel(c.item.baseUnit) })),
        spec: material ? ledger.material(material.id)?.spec ?? undefined : undefined,
        quantity: it.quantity!,
        unit: ledger.unitLabel(unitCode),
        unitPrice: it.unitPrice === null ? null : parseMoneyToMinor(it.unitPrice),
      };
    });
  if (!items.length) {
    return {
      blocks: [text("Entendí que se hizo un pedido, pero no distinguí los materiales ni las cantidades. Escríbelos así: «Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba».")],
      proposals: [],
    };
  }
  let supplier = resolveSupplierMention(ledger, ex.supplier);
  if (!ex.supplier) {
    // No supplier said: suggest the usual supplier of the materials, if they all share one.
    const usual = new Set(items.map((i) => (i.materialId ? ledger.material(i.materialId)?.usualSupplierId : null)));
    const only = usual.size === 1 ? [...usual][0] : null;
    if (only) supplier = { status: "suggested", id: only, name: ledger.supplierName(only), candidates: [{ id: only, name: ledger.supplierName(only) }] };
  }
  if (supplier.status !== "matched") flags.push("supplierName");
  if (items.some((i) => i.match !== "matched")) flags.push("items");
  if (!ex.orderedBy) flags.push("orderedBy");
  const interpretation: OrderInterpretation = {
    kind: "order",
    supplierId: supplier.id,
    supplierName: supplier.name,
    supplierMatch: supplier.status,
    supplierCandidates: supplier.candidates.length ? supplier.candidates : undefined,
    number: ex.orderReference ?? "",
    date: dateOr(ex.date, today),
    orderedBy: ex.orderedBy ? personName(ledger, ex.orderedBy) : "",
    mode: ex.purchaseMode ?? "cuenta_corriente",
    items,
    statedTotal: ex.orderTotal === null ? null : parseMoneyToMinor(ex.orderTotal),
    document,
    flags,
  };
  const notes: string[] = [];
  if (supplier.status === "new" && supplier.name) notes.push(`${supplier.name} es un proveedor nuevo: se agregará al confirmar.`);
  if (supplier.status === "suggested") notes.push(`Supuse que el proveedor es ${supplier.name}; revísalo.`);
  if (!supplier.name) notes.push("No identifiqué el proveedor: complétalo antes de confirmar.");
  const weak = items.filter((i) => i.match === "suggested");
  if (weak.length) notes.push(`No estoy seguro de ${weak.map((i) => `«${i.mention}»`).join(" y ")}: lo asocié a ${weak.map((i) => i.material).join(" y ")}. Verifícalo tocando el ítem.`);
  const created = items.filter((i) => i.match === "new");
  if (created.length) notes.push(`${created.map((i) => i.material).join(" y ")} no ${created.length === 1 ? "está" : "están"} en el catálogo: se ${created.length === 1 ? "agregará" : "agregarán"} como material nuevo.`);
  const priced = items.every((i) => i.unitPrice !== null) || interpretation.statedTotal != null;
  const lead = document
    ? `Es un comprobante de pedido de ${supplier.name || "un proveedor"}. Revisa antes de guardar:`
    : `Entendí un pedido${supplier.name ? ` a ${supplier.name}` : ""}.${priced ? "" : " No mencionaste precios: el importe quedará a confirmar."} Revisa antes de guardar:`;
  const id = newId();
  return {
    blocks: [text(lead), ...(notes.length ? [{ type: "note" as const, text: notes.join(" ") }] : []), { type: "interpretation", id, interpretation, state: "pending" }],
    proposals: [{ id, intent: "create_order", interpretation }],
  };
}

function personName(ledger: Ledger, raw: string): string {
  const n = normalizeText(raw);
  const user = ledger.s.users.find((u) => normalizeText(u.name) === n || normalizeText(u.name).split(" ")[0] === n);
  return user?.name ?? titleCase(raw);
}

// ------------------------------------------------------------------ deliveries

export function deliveryItemsFor(ledger: Ledger, order: Order, requested: Map<string, number> | "all"): { items: InterpretedDeliveryItem[]; over: string[] } {
  const over: string[] = [];
  const items = ledger
    .items(order.id)
    .filter((i) => ledger.remainingMilli(i) > 0)
    .map((i) => {
      const remaining = ledger.remainingMilli(i);
      const wanted = requested === "all" ? remaining : requested.get(i.id) ?? 0;
      if (wanted > remaining) over.push(`${formatNumber(fromMilli(wanted))} ${ledger.unitLabel(i.unit)} ${ledger.material(i.materialId)?.shortName ?? i.description} (solo faltan ${formatNumber(fromMilli(remaining))})`);
      return {
        orderLineId: i.id,
        materialId: i.materialId,
        material: ledger.material(i.materialId)?.name ?? i.description,
        unit: ledger.unitLabel(i.unit),
        ordered: fromMilli(i.quantityMilli),
        before: fromMilli(ledger.deliveredMilli(i.id)),
        now: fromMilli(Math.min(wanted, remaining)),
      };
    });
  return { items, over };
}

/** Matches mentioned materials to the lines of one order; returns requested milli per order line. */
function requestedByLine(ledger: Ledger, order: Order, ex: Extraction): { map: Map<string, number>; unmatched: string[] } {
  const lines = ledger.items(order.id);
  const candidates = lines.map((i) => ({ ...materialCandidates(ledger).find((m) => m.id === i.materialId)!, lineId: i.id }));
  const map = new Map<string, number>();
  const unmatched: string[] = [];
  for (const it of ex.items) {
    if (it.quantity === null) continue;
    const match = matchMaterial(it.material, candidates);
    const milli = toMilli(it.quantity);
    if (match.status === "new" || milli === null) {
      unmatched.push(it.material);
      continue;
    }
    const lineId = match.best!.lineId;
    map.set(lineId, (map.get(lineId) ?? 0) + milli);
  }
  return { map, unmatched };
}

function openOrders(ledger: Ledger, supplierId?: string | null): Order[] {
  return ledger.s.orders
    .filter((o) => (!supplierId || o.supplierId === supplierId) && ledger.orderDeliveryStatus(o) !== "entregado")
    .sort((a, b) => a.orderDate.localeCompare(b.orderDate));
}

export function buildDeliveryInterpretation(ledger: Ledger, order: Order, requested: Map<string, number> | "all", base: { remito: string; date: string; document?: Attachment; flags: string[] }) {
  const { items, over } = deliveryItemsFor(ledger, order, requested);
  const interpretation: DeliveryInterpretation = {
    kind: "delivery",
    supplierId: order.supplierId,
    supplierName: ledger.supplierName(order.supplierId),
    orderId: order.id,
    orderNumber: ledger.orderNumber(order),
    remito: base.remito,
    date: base.date,
    items,
    document: base.document,
    flags: base.flags,
  };
  return { interpretation, over };
}

export function proposeDelivery(ledger: Ledger, ex: Extraction, today: string, document?: Attachment): ProposalResult {
  const supplier = ex.supplier ? resolveSupplierMention(ledger, ex.supplier) : null;
  const supplierId = supplier && supplier.status !== "new" ? supplier.id : null;
  let order: Order | undefined;
  let inferred = false;
  let alternatives: Order[] = [];
  if (ex.orderReference) {
    const found = findOrdersByReference(ex.orderReference, ledger.s.orders, supplierId ?? undefined);
    if (!found.length) {
      return { blocks: [text(`No encontré el pedido ${ex.orderReference}${supplierId ? ` de ${ledger.supplierName(supplierId)}` : ""}. Revisa el número o cuéntame primero qué se pidió.`)], proposals: [] };
    }
    if (found.length > 1) {
      return {
        blocks: [
          text(`Hay ${found.length} pedidos ${ex.orderReference}. ¿De qué proveedor es la entrega?`),
          { type: "actions", actions: found.map((o) => ({ label: ledger.supplierName(o.supplierId), icon: "truck" as const, prompt: `Del pedido ${ledger.orderNumber(o)} de ${ledger.supplierName(o.supplierId)} llegó todo lo pendiente` })) },
        ],
        proposals: [],
      };
    }
    order = found[0];
  } else {
    const wanted = ex.items.map((it) => matchMaterial(it.material, materialCandidates(ledger))).filter((m) => m.status !== "new").map((m) => m.best!.id);
    const pool = openOrders(ledger, supplierId);
    const candidates = wanted.length ? pool.filter((o) => ledger.items(o.id).some((i) => wanted.includes(i.materialId) && ledger.remainingMilli(i) > 0)) : pool;
    if (!candidates.length) {
      return {
        blocks: [text(ex.items.length ? `No encontré pedidos con ${ex.items.map((i) => i.material).join(" y ")} pendientes de entrega${supplierId ? ` de ${ledger.supplierName(supplierId)}` : ""}. Si es material de un pedido nuevo, cuéntame primero qué se pidió y a quién.` : "No encontré pedidos con entregas pendientes. Si es material de un pedido nuevo, cuéntame primero qué se pidió y a quién.")],
        proposals: [],
      };
    }
    // Prefer the order whose remaining quantities match what arrived exactly, then the oldest.
    const score = (o: Order) => {
      const { map } = requestedByLine(ledger, o, ex);
      let s = 0;
      for (const [lineId, milli] of map) {
        const item = ledger.orderItem(lineId)!;
        if (ledger.remainingMilli(item) === milli) s += 2;
        else if (ledger.remainingMilli(item) > milli) s += 1;
      }
      return s;
    };
    const ranked = [...candidates].sort((a, b) => score(b) - score(a) || a.orderDate.localeCompare(b.orderDate));
    order = ranked[0];
    alternatives = ranked.slice(1);
    inferred = true;
  }
  if (!order) return { blocks: [text("No encontré el pedido de esta entrega.")], proposals: [] };
  if (ledger.orderDeliveryStatus(order) === "entregado") {
    return { blocks: [text(`El pedido ${ledger.orderNumber(order)} ya figura como entregado completo. Si llegó algo más, puede ser de otro pedido.`)], proposals: [] };
  }
  const all = ex.deliverAllPending || ex.items.length === 0;
  const { map, unmatched } = all ? { map: new Map<string, number>(), unmatched: [] as string[] } : requestedByLine(ledger, order, ex);
  const flags: string[] = [];
  if (!ex.remito) flags.push("remito");
  if (inferred) flags.push("orderNumber");
  const { interpretation, over } = buildDeliveryInterpretation(ledger, order, all ? "all" : map, { remito: ex.remito ?? "", date: dateOr(ex.date, today), document, flags });
  if (interpretation.items.every((i) => i.now === 0)) {
    return { blocks: [text(`No encontré ${unmatched.length ? unmatched.join(" y ") : "esos materiales"} entre lo pendiente del pedido ${ledger.orderNumber(order)}. Revisa el pedido o indícame el número correcto.`)], proposals: [] };
  }
  const supplierName = ledger.supplierName(order.supplierId);
  const pendingBefore = ledger.orderDeliveryStatus(order);
  const lead = document
    ? `Es un remito de ${supplierName}. Lo asocié al pedido ${ledger.orderNumber(order)}${pendingBefore === "pendiente" ? ", que todavía no tenía entregas" : ""}. Revisa antes de guardar:`
    : inferred
      ? `Lo asocié al pedido ${ledger.orderNumber(order)} de ${supplierName}, que tenía ${pendingBefore === "pendiente" ? "todo pendiente" : "entregas pendientes"}. Revisa antes de guardar:`
      : all
        ? `Calculé lo pendiente del pedido ${ledger.orderNumber(order)} de ${supplierName}. Revisa antes de guardar:`
        : `Registro la entrega del pedido ${ledger.orderNumber(order)} de ${supplierName}. Revisa antes de guardar:`;
  const notes: string[] = [];
  if (over.length) notes.push(`Ojo: ${over.join("; ")}. Propuse solo lo pendiente; si llegó de más, regístralo como otro pedido.`);
  if (unmatched.length) notes.push(`No encontré ${unmatched.join(" y ")} en este pedido.`);
  if (alternatives.length) notes.push(`También ${alternatives.length === 1 ? "tiene" : "tienen"} entregas pendientes: ${alternatives.slice(0, 3).map((o) => `pedido ${ledger.orderNumber(o)}`).join(", ")}. Si era otro, cambia el número de pedido.`);
  const id = newId();
  return {
    blocks: [text(lead), ...(notes.length ? [{ type: "note" as const, text: notes.join(" ") }] : []), { type: "interpretation", id, interpretation, state: "pending" }],
    proposals: [{ id, intent: ex.deliverAllPending ? "complete_order_delivery" : "register_delivery", interpretation }],
  };
}

// ------------------------------------------------------------------ payments

/** Recomputes the "Cómo queda" preview of a payment proposal from current balances. */
export function withPaymentPreview(ledger: Ledger, i: PaymentInterpretation): PaymentInterpretation {
  const supplier = ledger.supplier(i.supplierId);
  const before = supplier ? ledger.toSupplierSummary(supplier).balance : 0;
  const after = i.existingPaymentId ? before : before - i.amount;
  let unallocated = i.amount;
  let orderPendingBefore: number | undefined;
  let orderPendingAfter: number | undefined;
  const tags: StatusTag[] = [];
  if (i.allocation.type === "order") {
    const order = ledger.order(i.allocation.orderId);
    const pending = order ? ledger.orderPending(order) : null;
    const allocated = pending === null ? i.amount : Math.min(i.amount, pending);
    unallocated = i.amount - allocated;
    if (pending !== null) {
      orderPendingBefore = pending;
      orderPendingAfter = pending - allocated;
    }
    if (order) {
      const ds = ledger.orderDeliveryStatus(order);
      tags.push(ds === "entregado" ? "entregado" : ds === "parcial" ? "entrega_parcial" : "entrega_pendiente");
      tags.push(pending !== null && allocated >= pending ? "pagado" : "pago_parcial");
    }
  } else if (i.allocation.type === "split") {
    unallocated = i.amount - i.allocation.parts.reduce((s, p) => s + p.amount, 0);
    if (unallocated > 0) tags.push("pago_sin_imputar");
  } else tags.push("pago_sin_imputar");
  if (i.allocation.type === "order" && unallocated > 0) tags.push("pago_sin_imputar");
  return {
    ...i,
    supplierName: supplier?.name ?? i.supplierName,
    preview: {
      orderPendingBefore,
      orderPendingAfter,
      supplierBalanceBefore: before,
      supplierBalanceAfter: after,
      unallocatedAmount: Math.max(unallocated, 0),
      resultingTags: tags,
    },
  };
}

function paymentProposal(ledger: Ledger, base: Omit<PaymentInterpretation, "kind" | "preview" | "supplierName">): PaymentInterpretation {
  return withPaymentPreview(ledger, { kind: "payment", supplierName: ledger.supplierName(base.supplierId), preview: { supplierBalanceBefore: 0, supplierBalanceAfter: 0 }, ...base });
}

function interpretationBlocks(lead: string | null, interpretation: PaymentInterpretation, intent: string, notes: string[] = []): ProposalResult {
  const id = newId();
  return {
    blocks: [...(lead ? [text(lead)] : []), ...(notes.length ? [{ type: "note" as const, text: notes.join(" ") }] : []), { type: "interpretation", id, interpretation, state: "pending" }],
    proposals: [{ id, intent, interpretation }],
  };
}

export function proposePayment(ledger: Ledger, ex: Extraction, today: string, document?: Attachment): ProposalResult {
  const date = dateOr(ex.date, today);
  const method = ex.paymentMethod ?? "transferencia";
  let amount = ex.amount === null ? null : parseMoneyToMinor(ex.amount);
  const supplierMention = ex.supplier ? resolveSupplierMention(ledger, ex.supplier) : null;
  let supplierId = supplierMention && supplierMention.status !== "new" ? supplierMention.id : null;

  let order: Order | undefined;
  if (ex.orderReference && !ex.allocations.length) {
    const found = findOrdersByReference(ex.orderReference, ledger.s.orders, supplierId ?? undefined);
    if (found.length === 1) order = found[0];
    else if (found.length > 1) return { blocks: [text(`Hay más de un pedido ${ex.orderReference}. ¿De qué proveedor es el pago?`)], proposals: [] };
    else if (ex.paysFullOrderBalance || ex.intent === "pay_order_balance") return { blocks: [text(`No encontré el pedido ${ex.orderReference}. Revisa el número.`)], proposals: [] };
    if (order) supplierId = order.supplierId;
  }

  if (!supplierId) {
    const prompt = amount ? `Entendí un pago de ${formatMoney(amount)}. ¿A qué proveedor corresponde?` : "¿De cuánto fue el pago y a qué proveedor?";
    return {
      blocks: [
        text(supplierMention?.status === "new" ? `No encontré a «${ex.supplier}» entre los proveedores. ${prompt}` : prompt),
        { type: "actions", actions: ledger.s.suppliers.slice(0, 4).map((s) => ({ label: s.name, icon: "store" as const, prompt: `Pagamos ${amount ? formatMoney(amount) : ""} a ${s.name}`.replace("  ", " ") })) },
      ],
      proposals: [],
    };
  }
  const supplierName = ledger.supplierName(supplierId);

  // "Pagamos completo el pedido 27": the amount is the order's known outstanding balance — never invented.
  if (order && (ex.paysFullOrderBalance || ex.intent === "pay_order_balance")) {
    const value = ledger.orderValue(order);
    if (value === null) {
      return {
        blocks: [
          text(`El pedido ${ledger.orderNumber(order)} de ${supplierName} no tiene importe cargado, así que no puedo calcular cuánto falta pagar. Dime cuánto se pagó (por ejemplo «Pagamos $250.000 al pedido ${ledger.orderNumber(order)}») o completa los precios en el pedido.`),
          { type: "actions", actions: [{ label: "Ver pedidos", icon: "clipboard-list", link: { to: "/pedidos" } }] },
        ],
        proposals: [],
      };
    }
    const pending = ledger.orderPending(order)!;
    if (pending === 0) return { blocks: [text(`El pedido ${ledger.orderNumber(order)} ya está pagado completo. Si es otro pago, puedo registrarlo a la cuenta corriente de ${supplierName}.`)], proposals: [] };
    const paid = ledger.orderPaid(order.id);
    const interpretation = paymentProposal(ledger, { supplierId, amount: pending, date, method, allocation: { type: "order", orderId: order.id, orderNumber: ledger.orderNumber(order) }, document, flags: ex.paymentMethod ? [] : ["method"] });
    return interpretationBlocks(
      `El pedido ${ledger.orderNumber(order)} vale ${formatMoney(value)}${paid ? ` y ya tiene ${formatMoney(paid)} imputados` : ""}: el saldo es ${formatMoney(pending)}. Revisa antes de guardar:`,
      interpretation,
      "pay_order_balance",
    );
  }

  if (amount === null || amount <= 0) {
    return { blocks: [text(`¿De cuánto fue el pago a ${supplierName}? Puedes escribir el importe o adjuntar el comprobante de la transferencia.`)], proposals: [] };
  }

  // Explicit split: "600 mil al pedido 381 y 400 mil al 352".
  if (ex.allocations.length) {
    const parts: { orderId: string; orderNumber: string; amount: number }[] = [];
    const problems: string[] = [];
    for (const a of ex.allocations) {
      const found = findOrdersByReference(a.orderReference, ledger.s.orders, supplierId);
      const partAmount = a.amount === null ? null : parseMoneyToMinor(a.amount);
      if (found.length !== 1 || partAmount === null) {
        problems.push(`pedido ${a.orderReference}`);
        continue;
      }
      parts.push({ orderId: found[0]!.id, orderNumber: ledger.orderNumber(found[0]!), amount: partAmount });
    }
    const total = parts.reduce((s, p) => s + p.amount, 0);
    if (ex.amount === null) amount = total;
    if (problems.length) return { blocks: [text(`No pude identificar ${problems.join(" y ")} de ${supplierName}. Revisa los números de pedido.`)], proposals: [] };
    if (total > amount) return { blocks: [text(`Las partes (${formatMoney(total)}) suman más que el pago (${formatMoney(amount)}). Revisa los importes.`)], proposals: [] };
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, allocation: { type: "split", parts }, document, flags: [] });
    return interpretationBlocks(`Entendí un pago de ${formatMoney(amount)} a ${supplierName} repartido entre ${parts.length} pedidos. Revisa antes de guardar:`, interpretation, "create_payment");
  }

  if (order) {
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, allocation: { type: "order", orderId: order.id, orderNumber: ledger.orderNumber(order) }, document, flags: [] });
    const notes = interpretation.preview.unallocatedAmount ? [`El pago supera el saldo del pedido: ${formatMoney(interpretation.preview.unallocatedAmount)} quedarán sin imputar en la cuenta corriente.`] : [];
    return interpretationBlocks(null, interpretation, "create_payment", notes);
  }

  if (ex.toCurrentAccount || ex.intent === "record_supplier_account_payment") {
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, allocation: { type: "unallocated" }, document, flags: document ? ["amount"] : [] });
    return interpretationBlocks(document ? `Es un comprobante de pago a ${supplierName}. Lo propongo como pago a cuenta corriente, sin imputar:` : null, interpretation, "record_supplier_account_payment");
  }

  const open = ledger.s.orders.filter((o) => o.supplierId === supplierId && (ledger.orderPending(o) ?? 0) > 0).sort((a, b) => a.orderDate.localeCompare(b.orderDate));
  if (document) {
    // A receipt without an order number: suggest an order only when the amount matches its balance exactly.
    const exact = open.filter((o) => ledger.orderPending(o) === amount);
    const allocation = exact.length === 1 ? { type: "order" as const, orderId: exact[0]!.id, orderNumber: ledger.orderNumber(exact[0]!) } : { type: "unallocated" as const };
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, allocation, document, flags: ["allocation", "amount"] });
    return interpretationBlocks(
      exact.length === 1
        ? `Es un comprobante de pago a ${supplierName} por ${formatMoney(amount)}, igual al saldo del pedido ${ledger.orderNumber(exact[0]!)}. Revisa la imputación antes de guardar:`
        : `Es un comprobante de pago a ${supplierName} por ${formatMoney(amount)}. No indica pedido, así que lo propongo sin imputar:`,
      interpretation,
      "create_payment",
    );
  }

  const missing: string[] = [];
  if (!ex.date) missing.push("la fecha");
  if (!ex.paymentMethod) missing.push("el medio de pago");
  const options = [
    ...open.slice(0, 3).map((o) => {
      const pending = ledger.orderPending(o) ?? 0;
      return { id: `order:${o.id}`, title: `Al pedido ${ledger.orderNumber(o)}`, description: `Saldo ${formatMoney(pending)} · ${amount! >= pending ? "quedaría pagado" : "quedaría con pago parcial"}` };
    }),
    { id: "account", title: "A la cuenta corriente", description: "Reduce el saldo sin imputar a un pedido" },
    { id: "split", title: "Repartir entre pedidos", description: "Eliges cuánto va a cada pedido" },
  ];
  const ordersText = open.length === 0 ? "No tiene pedidos con saldo" : open.length === 1 ? "Tiene un solo pedido con saldo" : `Tiene ${open.length} pedidos con saldo`;
  return {
    blocks: [
      text(`Entendí un pago de ${formatMoney(amount)} a ${supplierName}. ${ordersText}. ¿A qué corresponde?`),
      {
        type: "choice",
        id: newId(),
        options,
        selected: options[0]!.id,
        warning: missing.length ? `Falta ${missing.join(" y ")}. Usaré ${[!ex.date ? "hoy" : "", !ex.paymentMethod ? "transferencia" : ""].filter(Boolean).join(" y ")} si no me dices otra cosa.` : undefined,
        context: { supplierId, amount, date, method },
      },
    ],
    proposals: [],
  };
}

export function resolvePaymentChoice(ledger: Ledger, optionId: string, context: { supplierId: string; amount: number; date?: string; method?: PaymentInterpretation["method"] }, today: string): ProposalResult {
  if (optionId === "split") {
    return { blocks: [text("Dime cuánto va a cada pedido, por ejemplo «300 mil al pedido 38 y el resto a cuenta corriente».")], proposals: [] };
  }
  assertSupplier(ledger, context.supplierId);
  const order = optionId.startsWith("order:") ? ledger.order(optionId.slice(6)) : undefined;
  const interpretation = paymentProposal(ledger, {
    supplierId: context.supplierId,
    amount: context.amount,
    date: context.date ?? today,
    method: context.method ?? "transferencia",
    allocation: order ? { type: "order", orderId: order.id, orderNumber: ledger.orderNumber(order) } : { type: "unallocated" },
    flags: [],
  });
  return interpretationBlocks(null, interpretation, order ? "create_payment" : "record_supplier_account_payment");
}

function assertSupplier(ledger: Ledger, id: string) {
  if (!ledger.supplier(id)) throw new Error("Proveedor inexistente");
}

/** "Imputar el pago sin imputar de Hierros Córdoba al pedido 381". */
export function proposeAllocation(ledger: Ledger, ex: Extraction): ProposalResult {
  let order: Order | undefined;
  const mention = ex.supplier ? resolveSupplierMention(ledger, ex.supplier) : null;
  let supplierId = mention && mention.status !== "new" ? mention.id : null;
  if (ex.orderReference) {
    const found = findOrdersByReference(ex.orderReference, ledger.s.orders, supplierId ?? undefined);
    if (found.length === 1) {
      order = found[0];
      supplierId = order!.supplierId;
    }
  }
  if (!supplierId) return { blocks: [text("¿De qué proveedor es el pago que quieres imputar?")], proposals: [] };
  const payments = ledger.s.payments.filter((p) => p.supplierId === supplierId && ledger.paymentUnallocated(p) > 0).sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
  const payment = payments[0];
  if (!payment) return { blocks: [text(`${ledger.supplierName(supplierId)} no tiene pagos sin imputar.`)], proposals: [] };
  order ??= ledger.s.orders.filter((o) => o.supplierId === supplierId && (ledger.orderPending(o) ?? 0) > 0).sort((a, b) => a.orderDate.localeCompare(b.orderDate))[0];
  if (!order) return { blocks: [text(`${ledger.supplierName(supplierId)} no tiene pedidos con saldo conocido para imputar el pago.`)], proposals: [] };
  const free = ledger.paymentUnallocated(payment);
  const pending = ledger.orderPending(order);
  if (pending === 0) return { blocks: [text(`El pedido ${ledger.orderNumber(order)} ya está pagado.`)], proposals: [] };
  const amount = pending === null ? free : Math.min(free, pending);
  const interpretation = paymentProposal(ledger, {
    supplierId,
    amount,
    date: payment.paymentDate,
    method: (payment.method ?? "otro") as PaymentInterpretation["method"],
    allocation: { type: "order", orderId: order.id, orderNumber: ledger.orderNumber(order) },
    existingPaymentId: payment.id,
    flags: [],
  });
  return interpretationBlocks(
    `Propongo imputar ${formatMoney(amount)} del pago del ${formatDate(payment.paymentDate)} al pedido ${ledger.orderNumber(order)}${ex.orderReference ? "" : ", el más antiguo con saldo"}. El saldo del proveedor no cambia.`,
    interpretation,
    "allocate_payment",
  );
}

