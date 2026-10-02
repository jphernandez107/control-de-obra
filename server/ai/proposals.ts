import type {
  AssistantBlock,
  Attachment,
  DeliveryInterpretation,
  InterpretedDeliveryItem,
  InterpretedOrderItem,
  OrderInterpretation,
  PaymentInterpretation,
  SuggestedAction,
} from "../../src/domain/assistant";
import type { StatusTag } from "../../src/domain/types";
import { formatDate, formatMoney, formatNumber } from "../../src/domain/format";
import type { Ledger } from "../domain/derive";
import { canonicalMaterialName, matchMaterial } from "../domain/matching";
import { parseMoneyToMinor } from "../domain/money";
import { fromMilli, toMilli } from "../domain/quantity";
import { orderFinancialSummary } from "../domain/summaries";
import { normalizeText } from "../domain/text";
import { isValidDate } from "../domain/time";
import { resolveOrderLineUnit, unitCodeFromWord, type UnitSize } from "../domain/units";
import type { Order } from "../repositories/snapshot";
import { materialCandidates, rankOrderCandidates, resolveOrderReference, resolveSupplierMention, titleCase } from "./resolve";
import type { AllocatePaymentIntent, CompleteOrderDeliveryIntent, CreateOrderIntent, CreateSupplierPaymentIntent, ItemMention, PayOrderBalanceIntent, RegisterDeliveryIntent } from "./schemas";

// Turns a validated intent into application-owned proposals (pending AI
// actions). All matching (supplier, material, order) and every figure
// (remaining quantities, balances) is computed here from persisted records —
// never taken from the provider. Proposals are only shown; nothing is written.

export interface Proposal {
  id: string;
  intent: string;
  interpretation: OrderInterpretation | DeliveryInterpretation | PaymentInterpretation;
}

export interface ProposalResult {
  blocks: AssistantBlock[];
  proposals: Proposal[];
  /** Records this reply is about (for follow-up questions). */
  refs?: { orderIds?: string[]; supplierIds?: string[]; materialIds?: string[] };
}

/** Context the assistant adds to an intent: the analyzed document and the conversation focus. */
export interface ProposalOptions {
  document?: Attachment;
  /** Order the conversation was last about, used only when the message names none. */
  focusOrderId?: string;
}

const newId = () => crypto.randomUUID();

export { materialCandidates, resolveSupplierMention } from "./resolve";

function text(t: string): AssistantBlock {
  return { type: "text", text: t };
}

function dateOr(value: string | null, today: string): string {
  return value && isValidDate(value) ? value : today;
}

function orderChips(ledger: Ledger, orders: Order[], prompt: (o: Order) => string, icon: SuggestedAction["icon"]): AssistantBlock {
  return { type: "actions", actions: orders.slice(0, 4).map((o) => ({ label: `Pedido ${ledger.orderNumber(o)} · ${ledger.supplierName(o.supplierId)}`, icon, prompt: prompt(o) })) };
}

// ------------------------------------------------------------------ orders

export function proposeOrder(ledger: Ledger, ex: CreateOrderIntent, today: string, options: ProposalOptions = {}): ProposalResult {
  const document = options.document;
  const materials = materialCandidates(ledger);
  const flags: string[] = [];
  const corrected: string[] = [];
  const unconvertible: string[] = [];
  const items: InterpretedOrderItem[] = ex.items
    .filter((it) => it.quantity !== null && it.quantity > 0)
    .map((it, idx) => {
      const match = matchMaterial(it.material, materials);
      const material = match.status === "new" ? undefined : match.best!;
      const line = orderLineUnit(ledger, it, material?.baseUnit ?? null);
      if (line.corrected) corrected.push(`${formatNumber(it.quantity!)} ${ledger.unitLabel(line.unit)} de ${formatNumber(fromMilli(line.size!.milli))} ${ledger.unitLabel(line.size!.unit)} (${material?.name ?? canonicalMaterialName(it.material).name})`);
      if (material && line.unit !== material.baseUnit && ledger.inBaseUnit(material.id, 1000, line.unit) === null && !(line.size && line.size.unit === material.baseUnit)) {
        unconvertible.push(`${material.name} se lleva en ${ledger.unitLabel(material.baseUnit)} y aquí figura en ${ledger.unitLabel(line.unit)}`);
      }
      const canonical = canonicalMaterialName(it.material);
      return {
        id: `item-${idx + 1}`,
        materialId: material?.id ?? null,
        material: material?.name ?? canonical.name,
        mention: it.material,
        match: match.status,
        candidates: match.status === "matched" ? undefined : match.candidates.map((c) => ({ id: c.item.id, name: c.item.name, unit: ledger.unitLabel(c.item.baseUnit) })),
        spec: material ? ledger.material(material.id)?.spec ?? undefined : undefined,
        quantity: it.quantity!,
        unit: ledger.unitLabel(line.unit),
        unitSize: line.size ? { quantity: fromMilli(line.size.milli), unit: ledger.unitLabel(line.size.unit) } : undefined,
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
  if (!ex.requestedBy) flags.push("orderedBy");
  const interpretation: OrderInterpretation = {
    kind: "order",
    supplierId: supplier.id,
    supplierName: supplier.name,
    supplierMatch: supplier.status,
    supplierCandidates: supplier.candidates.length ? supplier.candidates : undefined,
    number: ex.orderReference ?? "",
    date: dateOr(ex.date, today),
    orderedBy: ex.requestedBy ? personName(ledger, ex.requestedBy) : "",
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
  if (created.length) notes.push(`${listOf(created.map((i) => i.material))} no ${created.length === 1 ? "está" : "están"} en el catálogo: se ${created.length === 1 ? "agregará como material nuevo" : "agregarán como materiales nuevos"}.`);
  if (corrected.length) notes.push(`Tomé la cantidad como piezas compradas, no como medida: ${corrected.join("; ")}.`);
  if (unconvertible.length) notes.push(`${unconvertible.join("; ")}: no se sumarán a lo pedido en esa unidad. Corrige la unidad si no es así.`);
  const priced = items.every((i) => i.unitPrice !== null) || interpretation.statedTotal != null;
  const lead = document
    ? `Es un comprobante de pedido de ${supplier.name || "un proveedor"}. Revisa antes de guardar:`
    : `Entendí un pedido${supplier.name ? ` a ${supplier.name}` : ""}.${priced ? "" : " No mencionaste precios: el importe quedará a confirmar."} Revisa antes de guardar:`;
  const id = newId();
  return {
    blocks: [text(lead), ...(notes.length ? [{ type: "note" as const, text: notes.join(" ") }] : []), { type: "interpretation", id, interpretation, state: "pending" }],
    proposals: [{ id, intent: "create_order", interpretation }],
    refs: { supplierIds: supplier.id ? [supplier.id] : [], materialIds: items.flatMap((i) => (i.materialId ? [i.materialId] : [])) },
  };
}

/**
 * Purchase unit and size of an order line, decided by the application from
 * the printed description ("X BARRA 12 MT") and the provider's unit word, so
 * every provider gets the same result. The provider's own size fields are
 * used only when the description does not state one.
 */
export function orderLineUnit(ledger: Ledger, it: ItemMention, materialUnit: string | null): { unit: string; size: UnitSize | null; corrected: boolean } {
  const line = resolveOrderLineUnit(it.material, it.unit, ledger.s.units, materialUnit) ?? { unit: "unidad", size: null, corrected: false };
  if (line.size) return line;
  const sizeUnit = unitCodeFromWord(it.unitSizeUnit, ledger.s.units);
  const milli = it.unitSize ? toMilli(it.unitSize) : null;
  if (sizeUnit && milli && milli > 0 && sizeUnit !== line.unit && ["barra", "bolsa", "unidad", "malla"].includes(line.unit)) return { ...line, size: { milli, unit: sizeUnit } };
  return line;
}

/** "A, B y C". */
function listOf(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}`;
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

type DeliveredMention = { material: string; quantity: number | null; unit?: string | null };

/** Matches mentioned materials to the lines of one order; returns requested milli per order line. */
function requestedByLine(ledger: Ledger, order: Order, mentions: DeliveredMention[]): { map: Map<string, number>; unmatched: string[] } {
  const lines = ledger.items(order.id);
  const catalog = materialCandidates(ledger);
  const candidates = lines.flatMap((i) => {
    const m = catalog.find((c) => c.id === i.materialId);
    return m ? [{ ...m, lineId: i.id }] : [];
  });
  const map = new Map<string, number>();
  const unmatched: string[] = [];
  for (const it of mentions) {
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

export function buildDeliveryInterpretation(
  ledger: Ledger,
  order: Order,
  requested: Map<string, number> | "all",
  base: { remito: string; date: string; document?: Attachment; flags: string[]; completesOrder?: boolean },
) {
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
    completesOrder: base.completesOrder || undefined,
    document: base.document,
    flags: base.flags,
  };
  return { interpretation, over };
}

function deliveryPrompt(ledger: Ledger, order: Order, ex: RegisterDeliveryIntent | CompleteOrderDeliveryIntent): string {
  const head = `Del pedido ${ledger.orderNumber(order)} de ${ledger.supplierName(order.supplierId)}`;
  if (ex.intent === "complete_order_delivery" || !ex.items.length) return `${head} se entregó todo lo pendiente`;
  return `${head} llegaron ${ex.items.map((i) => `${formatNumber(i.quantity)} ${i.unit ?? ""} ${i.material}`.replace(/\s+/g, " ")).join(" y ")}`;
}

export function proposeDelivery(ledger: Ledger, ex: RegisterDeliveryIntent | CompleteOrderDeliveryIntent, today: string, options: ProposalOptions = {}): ProposalResult {
  const document = options.document;
  const completes = ex.intent === "complete_order_delivery";
  const mentions: DeliveredMention[] = ex.intent === "register_delivery" ? ex.items : [];
  const supplier = ex.supplier ? resolveSupplierMention(ledger, ex.supplier) : null;
  const supplierId = supplier && supplier.status !== "new" ? supplier.id : null;
  let order: Order | undefined;
  let inferred = false;
  let alternatives: Order[] = [];
  if (ex.orderReference) {
    const found = resolveOrderReference(ledger, ex.orderReference, supplierId);
    if (found.status === "not_found") {
      return { blocks: [text(`No encontré el pedido ${ex.orderReference}${supplierId ? ` de ${ledger.supplierName(supplierId)}` : ""}. Revisa el número o cuéntame primero qué se pidió.`)], proposals: [] };
    }
    if (found.status !== "ok") {
      const orders = found.candidates.map((c) => ledger.order(c.id)!);
      return {
        blocks: [text(`Hay ${orders.length} pedidos ${ex.orderReference}. ¿De qué proveedor es la entrega?`), orderChips(ledger, orders, (o) => deliveryPrompt(ledger, o, ex), "truck")],
        proposals: [],
      };
    }
    order = found.value;
  } else if (options.focusOrderId && ledger.order(options.focusOrderId) && ledger.orderDeliveryStatus(ledger.order(options.focusOrderId)!) !== "entregado" && (!supplierId || ledger.order(options.focusOrderId)!.supplierId === supplierId)) {
    // "Llegó todo lo pendiente" right after talking about one order.
    order = ledger.order(options.focusOrderId);
    inferred = true;
  } else {
    const catalog = materialCandidates(ledger);
    const materials = mentions.flatMap((it) => {
      const m = matchMaterial(it.material, catalog);
      return m.status === "new" ? [] : [{ materialId: m.best!.id, quantityMilli: it.quantity === null ? null : toMilli(it.quantity) }];
    });
    const pool = openOrders(ledger, supplierId);
    const ranked = rankOrderCandidates(ledger, { supplierId, date: ex.date, materials }, pool);
    if (ranked.status === "not_found") {
      return {
        blocks: [
          text(
            mentions.length
              ? `No encontré pedidos con ${mentions.map((i) => i.material).join(" y ")} pendientes de entrega${supplierId ? ` de ${ledger.supplierName(supplierId)}` : ""}. Si es material de un pedido nuevo, cuéntame primero qué se pidió y a quién.`
              : `No sé de qué pedido es la entrega${supplierId ? ` de ${ledger.supplierName(supplierId)}` : ""}. Indícame el número de pedido.`,
          ),
        ],
        proposals: [],
      };
    }
    if (ranked.status !== "ok") {
      // Close candidates are never picked automatically.
      const orders = ranked.candidates.map((c) => ledger.order(c.id)!);
      return {
        blocks: [text(`Hay ${orders.length} pedidos que podrían corresponder a esta entrega. ¿De cuál es?`), orderChips(ledger, orders, (o) => deliveryPrompt(ledger, o, ex), "truck")],
        proposals: [],
        refs: { orderIds: orders.map((o) => o.id) },
      };
    }
    order = ranked.value;
    alternatives = ranked.ranked.filter((o) => o.id !== order!.id);
    inferred = true;
  }
  if (!order) return { blocks: [text("No encontré el pedido de esta entrega.")], proposals: [] };
  if (ledger.orderDeliveryStatus(order) === "entregado") {
    return { blocks: [text(`El pedido ${ledger.orderNumber(order)} ya figura como entregado completo. Si llegó algo más, puede ser de otro pedido.`)], proposals: [], refs: { orderIds: [order.id] } };
  }
  const all = completes || mentions.length === 0;
  const { map, unmatched } = all ? { map: new Map<string, number>(), unmatched: [] as string[] } : requestedByLine(ledger, order, mentions);
  const flags: string[] = [];
  if (!ex.deliveryReference) flags.push("remito");
  if (inferred) flags.push("orderNumber");
  const { interpretation, over } = buildDeliveryInterpretation(ledger, order, all ? "all" : map, {
    remito: ex.deliveryReference ?? "",
    date: dateOr(ex.date, today),
    document,
    flags,
    completesOrder: all,
  });
  if (interpretation.items.every((i) => i.now === 0)) {
    return { blocks: [text(`No encontré ${unmatched.length ? unmatched.join(" y ") : "esos materiales"} entre lo pendiente del pedido ${ledger.orderNumber(order)}. Revisa el pedido o indícame el número correcto.`)], proposals: [], refs: { orderIds: [order.id] } };
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
    proposals: [{ id, intent: ex.intent, interpretation }],
    refs: { orderIds: [order.id], supplierIds: [order.supplierId] },
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

export function proposePayment(ledger: Ledger, ex: CreateSupplierPaymentIntent | PayOrderBalanceIntent, today: string, options: ProposalOptions = {}): ProposalResult {
  const document = options.document;
  const payFull = ex.intent === "pay_order_balance";
  const date = dateOr(ex.date, today);
  const method = ex.paymentMethod ?? "transferencia";
  const allocations = ex.intent === "create_supplier_payment" ? ex.allocations : [];
  const toCurrentAccount = ex.intent === "create_supplier_payment" && ex.toCurrentAccount;
  if (ex.intent === "create_supplier_payment" && ex.currency === "USD") {
    return { blocks: [text("Por ahora solo registro pagos en pesos. Indícame el importe en pesos que se pagó.")], proposals: [] };
  }
  let amount = ex.intent === "create_supplier_payment" && ex.amount !== null ? parseMoneyToMinor(ex.amount) : null;
  const supplierMention = ex.supplier ? resolveSupplierMention(ledger, ex.supplier) : null;
  let supplierId = supplierMention && supplierMention.status !== "new" ? supplierMention.id : null;

  let order: Order | undefined;
  if (ex.orderReference && !allocations.length) {
    const found = resolveOrderReference(ledger, ex.orderReference, supplierId);
    if (found.status === "ok") order = found.value;
    else if (found.status === "ambiguous") {
      const orders = found.candidates.map((c) => ledger.order(c.id)!);
      return {
        blocks: [
          text(`Hay más de un pedido ${ex.orderReference}. ¿De qué proveedor es el pago?`),
          orderChips(ledger, orders, (o) => (payFull ? `Pagamos completo el pedido ${ledger.orderNumber(o)} de ${ledger.supplierName(o.supplierId)}` : `Pagamos ${amount ? formatMoney(amount) : ""} al pedido ${ledger.orderNumber(o)} de ${ledger.supplierName(o.supplierId)}`.replace("  ", " ")), "store"),
        ],
        proposals: [],
      };
    } else if (payFull) return { blocks: [text(`No encontré el pedido ${ex.orderReference}. Revisa el número.`)], proposals: [] };
    if (order) supplierId = order.supplierId;
  } else if (payFull && !ex.orderReference && options.focusOrderId && ledger.order(options.focusOrderId)) {
    // "Pagalo completo" right after talking about one order.
    order = ledger.order(options.focusOrderId);
    supplierId = order!.supplierId;
  }

  if (payFull && !order) {
    return { blocks: [text("¿Qué pedido se pagó completo? Indícame el número, por ejemplo «Pagamos completo el pedido 38».")], proposals: [] };
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

  // "Pagamos completo el pedido 38": the amount is the order's known outstanding balance — never invented.
  if (order && payFull) {
    const financial = orderFinancialSummary(ledger, order);
    if (financial.knownTotalMinor === null || financial.remainingBalanceMinor === null) {
      return {
        blocks: [
          text(`El pedido ${ledger.orderNumber(order)} de ${supplierName} no tiene importe cargado, así que no puedo calcular cuánto falta pagar. Dime cuánto se pagó (por ejemplo «Pagamos $250.000 al pedido ${ledger.orderNumber(order)}») o completa los precios en el pedido.`),
          { type: "actions", actions: [{ label: "Ver pedidos", icon: "clipboard-list", link: { to: "/pedidos" } }] },
        ],
        proposals: [],
        refs: { orderIds: [order.id], supplierIds: [supplierId] },
      };
    }
    const pending = financial.remainingBalanceMinor;
    if (pending === 0) return { blocks: [text(`El pedido ${ledger.orderNumber(order)} ya está pagado completo. Si es otro pago, puedo registrarlo a la cuenta corriente de ${supplierName}.`)], proposals: [], refs: { orderIds: [order.id] } };
    const interpretation = paymentProposal(ledger, {
      supplierId,
      amount: pending,
      date,
      method,
      reference: ex.paymentReference ?? undefined,
      allocation: { type: "order", orderId: order.id, orderNumber: ledger.orderNumber(order) },
      paysOrderBalance: true,
      document,
      flags: ex.paymentMethod ? [] : ["method"],
    });
    return withRefs(
      interpretationBlocks(
        `El pedido ${ledger.orderNumber(order)} vale ${formatMoney(financial.knownTotalMinor)}${financial.allocatedPaidMinor ? ` y ya tiene ${formatMoney(financial.allocatedPaidMinor)} imputados` : ""}: el saldo es ${formatMoney(pending)}. Revisa antes de guardar:`,
        interpretation,
        "pay_order_balance",
      ),
      { orderIds: [order.id], supplierIds: [supplierId] },
    );
  }

  if (amount === null || amount <= 0) {
    return { blocks: [text(`¿De cuánto fue el pago a ${supplierName}? Puedes escribir el importe o adjuntar el comprobante de la transferencia.`)], proposals: [], refs: { supplierIds: [supplierId] } };
  }
  const reference = ex.paymentReference ?? undefined;

  // Explicit split: "600 mil al pedido 381 y 400 mil al 352".
  if (allocations.length) {
    const parts: { orderId: string; orderNumber: string; amount: number }[] = [];
    const problems: string[] = [];
    for (const a of allocations) {
      const found = resolveOrderReference(ledger, a.orderReference, supplierId);
      const partAmount = a.amount === null ? null : parseMoneyToMinor(a.amount);
      if (found.status !== "ok" || partAmount === null) {
        problems.push(`pedido ${a.orderReference}`);
        continue;
      }
      parts.push({ orderId: found.value.id, orderNumber: ledger.orderNumber(found.value), amount: partAmount });
    }
    const total = parts.reduce((s, p) => s + p.amount, 0);
    if (problems.length) return { blocks: [text(`No pude identificar ${problems.join(" y ")} de ${supplierName}. Revisa los números de pedido.`)], proposals: [] };
    if (total > amount) return { blocks: [text(`Las partes (${formatMoney(total)}) suman más que el pago (${formatMoney(amount)}). Revisa los importes.`)], proposals: [] };
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, reference, allocation: { type: "split", parts }, document, flags: [] });
    return withRefs(interpretationBlocks(`Entendí un pago de ${formatMoney(amount)} a ${supplierName} repartido entre ${parts.length} pedidos. Revisa antes de guardar:`, interpretation, "create_supplier_payment"), {
      orderIds: parts.map((p) => p.orderId),
      supplierIds: [supplierId],
    });
  }

  if (order) {
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, reference, allocation: { type: "order", orderId: order.id, orderNumber: ledger.orderNumber(order) }, document, flags: [] });
    const notes = interpretation.preview.unallocatedAmount ? [`El pago supera el saldo del pedido: ${formatMoney(interpretation.preview.unallocatedAmount)} quedarán sin imputar en la cuenta corriente.`] : [];
    return withRefs(interpretationBlocks(null, interpretation, "create_supplier_payment", notes), { orderIds: [order.id], supplierIds: [supplierId] });
  }

  if (toCurrentAccount) {
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, reference, allocation: { type: "unallocated" }, document, flags: document ? ["amount"] : [] });
    return withRefs(
      interpretationBlocks(
        document ? `Es un comprobante de pago a ${supplierName}. Lo propongo como pago a cuenta corriente, sin imputar:` : `Entendí un pago de ${formatMoney(amount)} a la cuenta corriente de ${supplierName}, sin imputar a un pedido. Revisa antes de guardar:`,
        interpretation,
        "create_supplier_payment",
      ),
      { supplierIds: [supplierId] },
    );
  }

  const open = ledger.s.orders.filter((o) => o.supplierId === supplierId && (ledger.orderPending(o) ?? 0) > 0).sort((a, b) => a.orderDate.localeCompare(b.orderDate));
  if (document) {
    // A receipt without an order number: suggest an order only when the amount matches its balance exactly.
    const exact = open.filter((o) => ledger.orderPending(o) === amount);
    const allocation = exact.length === 1 ? { type: "order" as const, orderId: exact[0]!.id, orderNumber: ledger.orderNumber(exact[0]!) } : { type: "unallocated" as const };
    const interpretation = paymentProposal(ledger, { supplierId, amount, date, method, reference, allocation, document, flags: ["allocation", "amount"] });
    return withRefs(
      interpretationBlocks(
        exact.length === 1
          ? `Es un comprobante de pago a ${supplierName} por ${formatMoney(amount)}, igual al saldo del pedido ${ledger.orderNumber(exact[0]!)}. Revisa la imputación antes de guardar:`
          : `Es un comprobante de pago a ${supplierName} por ${formatMoney(amount)}. No indica pedido, así que lo propongo sin imputar:`,
        interpretation,
        "create_supplier_payment",
      ),
      { supplierIds: [supplierId] },
    );
  }

  const missing: string[] = [];
  if (!ex.date) missing.push("la fecha");
  if (!ex.paymentMethod) missing.push("el medio de pago");
  const options_ = [
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
        options: options_,
        selected: options_[0]!.id,
        warning: missing.length ? `Falta ${missing.join(" y ")}. Usaré ${[!ex.date ? "hoy" : "", !ex.paymentMethod ? "transferencia" : ""].filter(Boolean).join(" y ")} si no me dices otra cosa.` : undefined,
        context: { supplierId, amount, date, method },
      },
    ],
    proposals: [],
    refs: { supplierIds: [supplierId] },
  };
}

function withRefs(result: ProposalResult, refs: ProposalResult["refs"]): ProposalResult {
  return { ...result, refs };
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
  return interpretationBlocks(null, interpretation, "create_supplier_payment");
}

function assertSupplier(ledger: Ledger, id: string) {
  if (!ledger.supplier(id)) throw new Error("Proveedor inexistente");
}

/** "Imputar el pago sin imputar de Hierros Córdoba al pedido 381". */
export function proposeAllocation(ledger: Ledger, ex: AllocatePaymentIntent): ProposalResult {
  let order: Order | undefined;
  const mention = ex.supplier ? resolveSupplierMention(ledger, ex.supplier) : null;
  let supplierId = mention && mention.status !== "new" ? mention.id : null;
  if (ex.orderReference) {
    const found = resolveOrderReference(ledger, ex.orderReference, supplierId);
    if (found.status === "ok") {
      order = found.value;
      supplierId = order.supplierId;
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

