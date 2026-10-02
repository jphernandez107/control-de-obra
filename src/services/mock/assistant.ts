import type {
  AnalysisStep,
  AssistantBlock,
  AssistantInput,
  Attachment,
  ChatMessage,
  ConfirmResult,
  Conversation,
  DeliveryInterpretation,
  Interpretation,
  InterpretedOrderItem,
  OrderInterpretation,
  PaymentInterpretation,
} from "@/domain/assistant";
import type { ActivityEvent, ID, StatusTag, Supplier } from "@/domain/types";
import { formatDate, formatMoney, formatNumber, initialsOf, paymentMethodLabel } from "@/domain/format";
import type { AssistantService } from "../types";
import { knownMaterials, knownSuppliers, type DbMaterial, type DbOrder } from "./db";
import { materialsOverview, toOrderSummary, toSupplierDetail, toSupplierSummary } from "./derive";
import { db, delay, nextId } from "./runtime";

// Deterministic stand-in for the AI. It recognises a handful of phrasings
// (orders, deliveries, payments, balance and pending questions) with plain
// regular expressions so the review → confirm flow can be demonstrated.

const LAST_PRICES: Record<string, number> = {
  "hierro-12": 38420,
  "hierro-10": 23798,
  "hierro-8": 15200,
  "malla-sima": 31500,
  cemento: 12400,
  cal: 9350,
  arena: 45000,
  ladrillo: 320,
  hormigon: 241667,
  "cano-pvc": 11900,
  "codo-pvc": 1712.5,
};

const PEOPLE: Record<string, string> = { marcelo: "Marcelo Ríos", juan: "Juan Hernández", raul: "Raúl Ferreyra" };

function norm(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function nowStamp(): string {
  return `${db.today}T${new Date().toTimeString().slice(0, 5)}`;
}

function allSuppliers(): Supplier[] {
  const extra = knownSuppliers.filter((k) => !db.suppliers.some((s) => s.id === k.id));
  return [...db.suppliers, ...extra];
}

function matchSupplier(text: string): Supplier | undefined {
  const t = norm(text);
  const keys: [string, string][] = [
    ["hierro", "hierros-cordoba"],
    ["sanitario", "sanitarios-centro"],
    ["ladriller", "ladrillera-algarrobo"],
    ["algarrobo", "ladrillera-algarrobo"],
    ["corralon", "corralon-san-martin"],
    ["san martin", "corralon-san-martin"],
    ["hormigoner", "hormigonera-sierras"],
  ];
  const byName = allSuppliers().find((s) => t.includes(norm(s.name)));
  if (byName) return byName;
  const hit = keys.find(([k]) => t.includes(k));
  return hit ? allSuppliers().find((s) => s.id === hit[1]) : undefined;
}

function matchOrderNumber(text: string): DbOrder | undefined {
  const m = norm(text).match(/pedido\s*(?:n\.?\s*[º°o]?\s*)?([a-z]?-?\d+)/);
  if (!m) return undefined;
  const wanted = m[1]!.replace(/^0+/, "");
  return db.orders.find((o) => norm(o.number).replace(/^0+/, "") === wanted || norm(o.number).replace(/^0+/, "") === wanted.replace(/^a-?/, "a-"));
}

/** "$500.000", "500.000", "400 mil", "1,5 millones" → number. */
function parseAmount(text: string): number | undefined {
  const t = norm(text);
  const millions = t.match(/(\d+(?:[.,]\d+)?)\s*(?:millones|millon|palos?)/);
  if (millions) return Math.round(Number(millions[1]!.replace(",", ".")) * 1_000_000);
  const thousands = t.match(/(\d+(?:[.,]\d+)?)\s*(?:mil|lucas?)\b/);
  if (thousands) return Math.round(Number(thousands[1]!.replace(",", ".")) * 1000);
  const money = t.match(/\$\s*([\d.]+(?:,\d+)?)/) ?? t.match(/\b(\d{1,3}(?:\.\d{3})+(?:,\d+)?)\b/);
  if (money) return Number(money[1]!.replace(/\./g, "").replace(",", "."));
  return undefined;
}

function catalogMaterial(id: string): DbMaterial | undefined {
  return db.materials.find((m) => m.id === id) ?? knownMaterials.find((m) => m.id === id);
}

/** Recognises "20 barras del 12 y 30 del 10" and "40 bolsas de cemento". */
function parseItems(text: string): { materialId: string; quantity: number }[] {
  const t = norm(text);
  const items: { materialId: string; quantity: number }[] = [];
  for (const m of t.matchAll(/(\d+)\s*(?:barras?\s*)?(?:de(?:l)?\s*)?(?:hierro\s*)?(?:o|ø|diametro\s*)?(12|10|8)\b(?!\s*(?:x|m\b))/g)) {
    items.push({ materialId: `hierro-${m[2]}`, quantity: Number(m[1]) });
  }
  const generic: [RegExp, string][] = [
    [/(\d+)\s*(?:bolsas?\s*)?(?:de\s*)?cemento/, "cemento"],
    [/(\d+)\s*(?:bolsas?\s*)?(?:de\s*)?cal\b/, "cal"],
    [/(\d+)\s*(?:m3|m³|metros?)\s*(?:de\s*)?arena/, "arena"],
    [/(\d+(?:\.\d{3})?)\s*ladrillos?/, "ladrillo"],
    [/(\d+)\s*(?:m3|m³|metros?)\s*(?:de\s*)?hormigon/, "hormigon"],
    [/(\d+)\s*mallas?/, "malla-sima"],
    [/(\d+)\s*canos?/, "cano-pvc"],
    [/(\d+)\s*codos?/, "codo-pvc"],
  ];
  for (const [re, id] of generic) {
    const m = t.match(re);
    if (m) items.push({ materialId: id, quantity: Number(m[1]!.replace(/\./g, "")) });
  }
  return items;
}

function nextOrderNumber(): string {
  if (!db.orders.some((o) => o.number === "381")) return "381";
  const max = Math.max(...db.orders.map((o) => Number(o.number.replace(/\D/g, "")) || 0).filter((n) => n < 1000));
  return String(max + 15);
}

function orderInterpretation(text: string, document?: Attachment): OrderInterpretation {
  const supplier = matchSupplier(text) ?? knownSuppliers[0]!;
  let parsed = parseItems(text);
  const flags: string[] = [];
  if (parsed.length === 0) {
    parsed = [
      { materialId: "hierro-12", quantity: 20 },
      { materialId: "hierro-10", quantity: 30 },
    ];
  }
  const items: InterpretedOrderItem[] = parsed.map((p, i) => {
    const m = catalogMaterial(p.materialId)!;
    return {
      id: `item-${i + 1}`,
      material: m.name.replace(/^Hierro /, "Barra "),
      spec: m.spec,
      quantity: p.quantity,
      unit: m.unit,
      unitPrice: LAST_PRICES[p.materialId] ?? null,
    };
  });
  if (!document) flags.push("precios");
  const who = norm(text).match(/^(\w+)\s+(?:pidio|encargo|compro)/);
  const orderedBy = who ? PEOPLE[who[1]!] ?? who[1]!.replace(/^\w/, (c) => c.toUpperCase()) : "Marcelo Ríos";
  if (!who || document) flags.push("orderedBy");
  const explicit = norm(text).match(/pedido\s*(?:n\.?\s*[º°o]?\s*)?(\d+)/);
  const number = explicit ? explicit[1]! : nextOrderNumber();
  if (!explicit && db.orders.length > 0) flags.push("number");
  return {
    kind: "order",
    supplierName: supplier.name,
    number,
    date: db.today,
    orderedBy,
    mode: /contado|efectivo/.test(norm(text)) ? "contado" : "cuenta_corriente",
    items,
    document,
    flags,
  };
}

function deliveryInterpretationFor(order: DbOrder, quantities: Map<string, number> | "all", remito: string, document?: Attachment): DeliveryInterpretation {
  const delivered = (lineId: string) =>
    db.deliveries.reduce((s, d) => s + d.lines.filter((l) => l.orderLineId === lineId).reduce((a, l) => a + l.quantity, 0), 0);
  return {
    kind: "delivery",
    supplierName: db.suppliers.find((s) => s.id === order.supplierId)?.name ?? "",
    orderId: order.id,
    orderNumber: order.number,
    remito,
    date: db.today,
    items: order.lines
      .map((l) => {
        const before = delivered(l.id);
        const rest = l.quantity - before;
        const now = quantities === "all" ? rest : Math.min(quantities.get(l.materialId) ?? 0, rest);
        return { orderLineId: l.id, material: l.description, unit: catalogMaterial(l.materialId)?.unit ?? "u", ordered: l.quantity, before, now };
      })
      .filter((i) => i.ordered > i.before),
    document,
    flags: remito ? [] : ["remito"],
  };
}

function openDeliveryOrders(supplierId?: string): DbOrder[] {
  return db.orders
    .filter((o) => !supplierId || o.supplierId === supplierId)
    .filter((o) => toOrderSummary(db, o).delivery.status !== "entregado")
    .sort((a, b) => b.date.localeCompare(a.date));
}

function deliveryReply(text: string, document?: Attachment): AssistantBlock[] {
  const t = norm(text);
  const explicit = matchOrderNumber(text);
  const supplier = matchSupplier(text);
  const parsed = parseItems(text);
  const everything = /\btodo\b|completo|todas?\b/.test(t) && parsed.length === 0;
  let order = explicit;
  if (!order && parsed.length) {
    order = openDeliveryOrders(supplier?.id).find((o) => o.lines.some((l) => parsed.some((p) => p.materialId === l.materialId)));
  }
  if (!order && db.pendingDelivery && !parsed.length && /sanitario/.test(t)) {
    order = db.orders.find((o) => o.id === db.pendingDelivery!.orderId);
  }
  order ??= openDeliveryOrders(supplier?.id)[0];
  if (!order) {
    return [{ type: "text", text: "No encontré pedidos con entregas pendientes. Si es material de un pedido nuevo, cuéntame primero qué se pidió y a quién." }];
  }
  if (toOrderSummary(db, order).delivery.status === "entregado") {
    return [{ type: "text", text: `El pedido ${order.number} ya figura como entregado completo. Si llegó algo más, puede ser de otro pedido.` }];
  }
  const quantities = everything || (!parsed.length && !document) ? "all" : new Map(parsed.map((p) => [p.materialId, p.quantity]));
  const interpretation = deliveryInterpretationFor(order, document && !parsed.length ? "all" : quantities, document ? "0012-4588" : "", document);
  if (document && interpretation.items.length > 1) interpretation.items[interpretation.items.length - 1]!.now = Math.max(interpretation.items.at(-1)!.now - 5, 0);
  const summary = toOrderSummary(db, order);
  const lead = explicit
    ? `Registro la entrega del pedido ${order.number} de ${summary.supplier.name}. Revisa antes de guardar:`
    : `Lo asocié al pedido ${order.number} de ${summary.supplier.name}, que tenía ${summary.delivery.status === "pendiente" ? "todo pendiente" : "entregas pendientes"}. Revisa antes de guardar:`;
  return [
    { type: "text", text: lead },
    { type: "interpretation", id: nextId("int"), interpretation, state: "pending" },
  ];
}

function paymentInterpretation(supplierId: string, amount: number, allocation: PaymentInterpretation["allocation"], flags: string[], document?: Attachment): PaymentInterpretation {
  const supplier = toSupplierSummary(db, supplierId);
  const order = allocation.type === "order" ? db.orders.find((o) => o.id === allocation.orderId) : undefined;
  const summary = order ? toOrderSummary(db, order) : undefined;
  const pendingBefore = summary?.pendingPayment ?? undefined;
  const pendingAfter = pendingBefore !== undefined ? Math.max(pendingBefore - amount, 0) : undefined;
  const tags: StatusTag[] = [];
  if (summary) {
    tags.push(summary.delivery.status === "entregado" ? "entregado" : summary.delivery.status === "parcial" ? "entrega_parcial" : "entrega_pendiente");
    tags.push(pendingAfter === 0 ? "pagado" : "pago_parcial");
  } else {
    tags.push("pago_sin_imputar");
  }
  return {
    kind: "payment",
    supplierId,
    supplierName: supplier.name,
    amount,
    date: db.today,
    method: "transferencia",
    allocation,
    preview: {
      orderPendingBefore: pendingBefore,
      orderPendingAfter: pendingAfter,
      supplierBalanceBefore: supplier.balance,
      supplierBalanceAfter: supplier.balance - amount,
      resultingTags: tags,
    },
    document,
    flags,
  };
}

function paymentReply(text: string, document?: Attachment): AssistantBlock[] {
  const t = norm(text);
  const explicitOrder = matchOrderNumber(text);
  const supplier = explicitOrder ? db.suppliers.find((s) => s.id === explicitOrder.supplierId) : matchSupplier(text);
  let amount = parseAmount(text);
  if (explicitOrder && (amount === undefined || /completo|todo|total/.test(t))) {
    amount = toOrderSummary(db, explicitOrder).pendingPayment ?? amount;
  }
  if (document && amount === undefined) amount = 500000;
  if (!supplier || !db.suppliers.some((s) => s.id === supplier.id)) {
    return [
      { type: "text", text: amount ? `Entendí un pago de ${formatMoney(amount)}. ¿A qué proveedor corresponde?` : "¿De cuánto fue el pago y a qué proveedor?" },
      {
        type: "actions",
        actions: db.suppliers.slice(0, 3).map((s) => ({ label: s.name, icon: "store" as const, prompt: `Pagamos ${amount ? formatMoney(amount) : ""} a ${s.name}`.replace("  ", " ") })),
      },
    ];
  }
  if (amount === undefined) {
    return [{ type: "text", text: `¿De cuánto fue el pago a ${supplier.name}? Puedes escribir el importe o adjuntar el comprobante de la transferencia.` }];
  }
  if (explicitOrder) {
    if ((toOrderSummary(db, explicitOrder).pendingPayment ?? 1) === 0) {
      return [{ type: "text", text: `El pedido ${explicitOrder.number} ya está pagado completo. Si es otro pago, puedo registrarlo a la cuenta corriente de ${supplier.name}.` }];
    }
    return [
      { type: "interpretation", id: nextId("int"), interpretation: paymentInterpretation(supplier.id, amount, { type: "order", orderId: explicitOrder.id, orderNumber: explicitOrder.number }, [], document), state: "pending" },
    ];
  }
  if (/cuenta corriente|a cuenta|sin imputar/.test(t) || document) {
    return [
      { type: "interpretation", id: nextId("int"), interpretation: paymentInterpretation(supplier.id, amount, { type: "unallocated" }, document ? ["amount"] : [], document), state: "pending" },
    ];
  }
  const open = db.orders
    .filter((o) => o.supplierId === supplier.id && (toOrderSummary(db, o).pendingPayment ?? 0) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const missing: string[] = [];
  if (!/\b(hoy|ayer|\d{1,2}\/\d{1,2})/.test(t)) missing.push("la fecha");
  if (!/transfer|efectivo|cheque/.test(t)) missing.push("el medio de pago");
  const options = [
    ...open.slice(0, 2).map((o) => {
      const s = toOrderSummary(db, o);
      const after = (s.pendingPayment ?? 0) - amount;
      return {
        id: `order:${o.id}`,
        title: `Al pedido ${o.number}`,
        description: `Saldo ${formatMoney(s.pendingPayment ?? 0)} · ${after <= 0 ? "quedaría pagado" : "quedaría con pago parcial"}`,
      };
    }),
    { id: "account", title: "A la cuenta corriente", description: "Reduce el saldo sin imputar a un pedido" },
    { id: "split", title: "Repartir entre pedidos", description: "Eliges cuánto va a cada pedido" },
  ];
  const ordersText = open.length === 0 ? "No tiene pedidos con saldo" : open.length === 1 ? "Tiene un solo pedido con saldo" : `Tiene ${open.length} pedidos con saldo`;
  return [
    { type: "text", text: `Entendí un pago de ${formatMoney(amount)} a ${supplier.name}. ${ordersText}. ¿A qué corresponde?` },
    {
      type: "choice",
      id: nextId("choice"),
      options,
      selected: options[0]!.id,
      warning: missing.length
        ? `Falta ${missing.join(" y ")}. Usaré ${missing.includes("la fecha") ? "hoy" : ""}${missing.length === 2 ? " y " : ""}${missing.includes("el medio de pago") ? "transferencia" : ""} si no me dices otra cosa.`
        : undefined,
      context: { supplierId: supplier.id, amount },
    },
  ];
}

function balanceReply(text: string): AssistantBlock[] {
  const supplier = matchSupplier(text);
  if (!supplier || !db.suppliers.some((s) => s.id === supplier.id)) {
    const total = db.suppliers.reduce((s, x) => s + toSupplierSummary(db, x.id).balance, 0);
    const lines = db.suppliers
      .map((s) => toSupplierSummary(db, s.id))
      .filter((s) => s.balance > 0)
      .map((s) => `${s.name}: ${formatMoney(s.balance)}`);
    if (!lines.length) return [{ type: "text", text: "Hoy no hay saldos pendientes con proveedores." }];
    return [{ type: "text", text: `El saldo total con proveedores es de ${formatMoney(total)}. ${lines.join(" · ")}.` }];
  }
  const detail = toSupplierDetail(db, supplier.id);
  const blocks: AssistantBlock[] = [
    { type: "text", text: `Hoy el saldo con ${supplier.name} es de ${formatMoney(detail.balance)}.` },
    {
      type: "balance",
      supplierId: supplier.id,
      ordered: detail.totalOrdered,
      paid: detail.totalPaid,
      balance: detail.balance,
      allocatedPaid: detail.allocatedPaid,
      unallocatedPaid: detail.unallocatedPaid,
      rows: [
        ...detail.openOrderList
          .filter((o) => (o.pendingPayment ?? 0) > 0)
          .map((o) => ({
            label: `Pedido ${o.number}`,
            description: o.payment.status === "parcial" ? `Pago parcial · pagado ${formatMoney(o.paid)}` : "Sin pagos",
            amount: o.pendingPayment ?? 0,
            orderId: o.id,
          })),
        ...detail.unallocatedPayments.map((p) => ({
          label: "Sin imputar",
          description: `Pago del ${formatDate(p.date).slice(0, 5)}`,
          amount: -p.amount,
          unallocated: true,
        })),
      ],
    },
  ];
  if (detail.unallocatedPaid > 0) {
    blocks.push(
      { type: "text", text: `El pago de ${formatMoney(detail.unallocatedPaid)} todavía no está asignado a un pedido, pero ya reduce el saldo. ¿Quieres imputarlo?` },
      {
        type: "actions",
        actions: [
          { label: "Imputar el pago", icon: "git-fork", prompt: `Imputar el pago sin imputar de ${supplier.name} al pedido más antiguo` },
          { label: "Ver cuenta corriente", icon: "store", link: { to: "/proveedores/$supplierId", params: { supplierId: supplier.id } } },
        ],
      },
    );
  }
  return blocks;
}

function pendingDeliveriesReply(): AssistantBlock[] {
  const open = openDeliveryOrders();
  if (!open.length) return [{ type: "text", text: "No hay pedidos pendientes de entrega. Todo lo pedido ya llegó." }];
  return [
    { type: "text", text: open.length === 1 ? "Hay 1 pedido pendiente de entrega:" : `Hay ${open.length} pedidos pendientes de entrega:` },
    {
      type: "pending_deliveries",
      rows: open.map((o) => {
        const s = toOrderSummary(db, o);
        return {
          orderId: o.id,
          orderNumber: o.number,
          supplier: s.supplier.name,
          pendingLabel: s.delivery.status === "pendiente" ? `Nada entregado · ${formatNumber(s.delivery.ordered)} u` : s.delivery.pendingLabel ?? "Entrega parcial",
        };
      }),
    },
  ];
}

function computationReply(): AssistantBlock[] {
  const overview = materialsOverview(db);
  if (!overview.materials.length) {
    return [{ type: "text", text: "Todavía no hay materiales registrados. Cuando registres el primer pedido podré compararlo con el cómputo." }];
  }
  if (!overview.computation.loaded) {
    return [
      { type: "text", text: "Aún no hay un cómputo cargado, así que no puedo compararlo. Esto es lo pedido y entregado hasta hoy:" },
      {
        type: "quantities",
        rows: overview.materials.filter((m) => m.category === "Hierros").map((m) => ({ material: m.name.replace(/ x 12 m$/, ""), ordered: m.ordered, delivered: m.delivered, unit: m.unit === "barras" ? "u" : m.unit })),
        computationPrompt: true,
      },
    ];
  }
  const over = overview.materials.filter((m) => m.computation?.status === "supera");
  const near = overview.materials.filter((m) => m.computation?.status === "cerca");
  const parts = [
    over.length ? `${over.map((m) => `${m.name.replace(/ x 12 m$/, "")} supera el cómputo (${m.computation!.percent}%)`).join(", ")}` : "Ningún material supera el cómputo",
    near.length ? `${near.map((m) => m.name.replace(/ x 12 m$/, "").replace(/ 12x18x33$/, "")).join(" y ")} ${near.length === 1 ? "está cerca" : "están cerca"}` : "",
  ].filter(Boolean);
  return [
    { type: "text", text: `Comparé lo pedido con el cómputo del ${formatDate(overview.computation.updatedAt!)}. ${parts.join("; ")}. El resto está dentro de lo previsto.` },
    { type: "actions", actions: [{ label: "Ver materiales y cómputo", icon: "clipboard-list", link: { to: "/materiales" } }] },
  ];
}

function allocateUnallocated(text: string): AssistantBlock[] {
  const supplier = matchSupplier(text);
  const detail = supplier && db.suppliers.some((s) => s.id === supplier.id) ? toSupplierDetail(db, supplier.id) : undefined;
  const payment = detail?.unallocatedPayments[0];
  const order = detail?.openOrderList.filter((o) => (o.pendingPayment ?? 0) > 0).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!detail || !payment || !order) return [{ type: "text", text: "No encontré pagos sin imputar para asignar." }];
  const interpretation = paymentInterpretation(detail.id, payment.amount, { type: "order", orderId: order.id, orderNumber: order.number }, []);
  interpretation.preview.supplierBalanceAfter = interpretation.preview.supplierBalanceBefore;
  return [
    { type: "text", text: `Propongo imputar los ${formatMoney(payment.amount)} del ${formatDate(payment.date)} al pedido ${order.number}, el más antiguo con saldo. El saldo del proveedor no cambia.` },
    { type: "interpretation", id: `alloc:${payment.id}:${nextId("int")}`, interpretation, state: "pending" },
  ];
}

function classifyAttachment(file: Attachment, text: string): "order" | "delivery" | "payment" | "error" {
  const n = norm(`${file.fileName} ${text}`);
  if (/borros|blur|ilegible/.test(n)) return "error";
  if (/remito|llego|llegaron|entrega/.test(n)) return "delivery";
  if (/pago|transfer|pagamos/.test(n)) return "payment";
  if (/pedido|pidio|presupuesto|orden/.test(n)) return "order";
  return db.orders.length === 0 ? "order" : "delivery";
}

async function analyze(kind: "order" | "delivery" | "payment" | "error", supplierName: string, onProgress?: (title: string, steps: AnalysisStep[]) => void) {
  const docLabel = { order: "comprobante de pedido", delivery: "remito", payment: "comprobante de pago", error: "sin identificar" }[kind];
  const labels = [
    `Tipo de documento: ${docLabel}`,
    `Proveedor: ${supplierName}`,
    kind === "payment" ? "Leyendo importe y fecha" : "Leyendo materiales y cantidades",
    kind === "delivery" ? "Buscando el pedido asociado" : "Calculando el total",
  ];
  const total = kind === "error" ? 2 : labels.length;
  for (let i = 0; i <= total; i++) {
    onProgress?.(
      "Leyendo el comprobante…",
      labels.map((label, j) => ({ label: kind === "error" && j > 0 ? label.replace(supplierName, "…") : label, state: j < i ? "done" : j === i ? "active" : "todo" })),
    );
    await delay(i === 0 ? 500 : 650);
  }
}

const undoers = new Map<ID, () => void>();

function addActivity(events: Omit<ActivityEvent, "id" | "at">[]): ID[] {
  const at = nowStamp();
  const ids = events.map(() => nextId("a"));
  events.forEach((e, i) => db.activity.unshift({ ...e, id: ids[i]!, at }));
  return ids;
}

function removeActivity(ids: ID[]) {
  db.activity = db.activity.filter((a) => !ids.includes(a.id));
}

function attachmentToDocument(att: Attachment, kind: "comprobante_pedido" | "remito" | "comprobante_pago", supplierId: string, orderId?: string, orderNumber?: string) {
  const id = nextId("doc");
  db.documents.push({ id, fileName: att.fileName, kind, format: att.format, sizeLabel: att.sizeLabel, date: db.today, supplierId, orderId, orderNumber });
  return id;
}

function confirmOrder(i: OrderInterpretation): ConfirmResult {
  let supplier = db.suppliers.find((s) => norm(s.name) === norm(i.supplierName));
  const createdSupplier = !supplier;
  if (!supplier) {
    const known = knownSuppliers.find((s) => norm(s.name) === norm(i.supplierName));
    supplier = known ? structuredClone(known) : { id: nextId("sup"), name: i.supplierName, initials: initialsOf(i.supplierName), category: "Varios" };
    db.suppliers.push(supplier);
  }
  const createdMaterials: string[] = [];
  const orderId = nextId("o");
  const lines = i.items.map((item, idx) => {
    const baseName = item.material.replace(/^Barra /, "Hierro ");
    let mat = db.materials.find((m) => norm(m.name) === norm(baseName));
    if (!mat) {
      const known = knownMaterials.find((m) => norm(m.name) === norm(baseName));
      mat = known ? structuredClone(known) : { id: nextId("mat"), name: baseName, shortName: baseName, category: supplier!.category, unit: item.unit, supplierId: supplier!.id };
      db.materials.push(mat);
      createdMaterials.push(mat.id);
    }
    return {
      id: `${orderId}-l${idx + 1}`,
      materialId: mat.id,
      description: item.material,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      amount: item.unitPrice === null ? null : Math.round(item.unitPrice * item.quantity),
    };
  });
  const documentIds = i.document ? [attachmentToDocument(i.document, "comprobante_pedido", supplier.id, orderId, i.number)] : [];
  db.orders.push({
    id: orderId,
    number: i.number,
    supplierId: supplier.id,
    date: i.date,
    orderedBy: i.orderedBy,
    orderedByRole: i.orderedBy === "Marcelo Ríos" ? "ingeniero" : undefined,
    mode: i.mode,
    lines,
    documentIds,
    registeredAt: db.today,
    registeredVia: "asistente",
  });
  const total = lines.every((l) => l.amount !== null) ? lines.reduce((s, l) => s + (l.amount ?? 0), 0) : undefined;
  const activityIds = addActivity([
    ...(i.document ? [{ kind: "documento_agregado" as const, title: "Documento agregado", description: `${i.document.fileName} · Comprobante de pedido · ${supplier.name}`, supplierId: supplier.id, orderId }] : []),
    {
      kind: "pedido_registrado",
      title: "Pedido registrado",
      description: `Pedido ${i.number} · ${supplier.name} · ${lines.length} ${lines.length === 1 ? "material" : "materiales"}${total !== undefined ? ` · ${formatMoney(total)}` : ""}`,
      supplierId: supplier.id,
      orderId,
      tags: ["entrega_pendiente", "sin_pagos", ...(i.document ? [] : ["sin_comprobante" as const])],
    },
  ]);
  const recordId = orderId;
  undoers.set(recordId, () => {
    db.orders = db.orders.filter((o) => o.id !== orderId);
    db.documents = db.documents.filter((d) => !documentIds.includes(d.id));
    db.materials = db.materials.filter((m) => !createdMaterials.includes(m.id));
    if (createdSupplier) db.suppliers = db.suppliers.filter((s) => s.id !== supplier!.id);
    removeActivity(activityIds);
  });
  return {
    recordId,
    title: `Pedido ${i.number} registrado`,
    subtitle: `${supplier.name} · ${formatDate(i.date)} · ${lines.length} ${lines.length === 1 ? "material" : "materiales"}`,
    link: { to: "/pedidos/$orderId", params: { orderId } },
    total,
    tags: ["entrega_pendiente", "sin_pagos"],
    documentName: i.document?.fileName,
  };
}

function confirmDelivery(i: DeliveryInterpretation): ConfirmResult {
  const order = db.orders.find((o) => o.id === i.orderId);
  if (!order) throw new Error("Pedido no encontrado");
  const deliveryId = nextId("d");
  const documentId = i.document ? attachmentToDocument(i.document, "remito", order.supplierId, order.id, order.number) : undefined;
  const lines = i.items.filter((it) => it.now > 0).map((it) => ({ orderLineId: it.orderLineId, quantity: it.now }));
  db.deliveries.push({ id: deliveryId, orderId: order.id, date: i.date, remito: i.remito || null, lines, documentId });
  const hadPending = db.pendingDelivery?.orderId === order.id ? db.pendingDelivery : undefined;
  if (hadPending) db.pendingDelivery = undefined;
  const summary = toOrderSummary(db, order);
  const what = i.items.filter((it) => it.now > 0).map((it) => `${formatNumber(it.now)} ${it.material.replace(/^Barra /, "barras ")}`).join(" y ");
  const activityIds = addActivity([
    { kind: "entrega_registrada", title: "Entrega registrada", description: `Pedido ${order.number} · ${what}${i.remito ? ` · Remito ${i.remito}` : ""}`, supplierId: order.supplierId, orderId: order.id },
    ...(i.document ? [{ kind: "documento_agregado" as const, title: "Documento agregado", description: `${i.document.fileName} · Remito · ${summary.supplier.name}`, supplierId: order.supplierId, orderId: order.id }] : []),
  ]);
  undoers.set(deliveryId, () => {
    db.deliveries = db.deliveries.filter((d) => d.id !== deliveryId);
    db.documents = db.documents.filter((d) => d.id !== documentId);
    if (hadPending) db.pendingDelivery = hadPending;
    removeActivity(activityIds);
  });
  const deliveryTag: StatusTag = summary.delivery.status === "entregado" ? "entregado" : "entrega_parcial";
  const paymentTag: StatusTag = summary.payment.status === "pagado" ? "pagado" : summary.payment.status === "parcial" ? "pago_parcial" : "sin_pagos";
  return {
    recordId: deliveryId,
    title: "Entrega registrada",
    subtitle: `Pedido ${order.number} · ${summary.supplier.name} · ${formatNumber(summary.delivery.delivered)} de ${formatNumber(summary.delivery.ordered)} u`,
    link: { to: "/pedidos/$orderId", params: { orderId: order.id } },
    tags: [deliveryTag, paymentTag],
    documentName: i.document?.fileName,
  };
}

function confirmPayment(blockId: ID, i: PaymentInterpretation): ConfirmResult {
  const allocatingExisting = blockId.startsWith("alloc:") ? blockId.split(":")[1] : undefined;
  if (allocatingExisting && i.allocation.type === "order") {
    const payment = db.payments.find((p) => p.id === allocatingExisting);
    if (payment) {
      const orderId = i.allocation.orderId;
      payment.orderId = orderId;
      const activityIds = addActivity([{ kind: "pago_imputado", title: "Pago imputado", description: `${formatMoney(payment.amount)} imputados al pedido ${i.allocation.orderNumber} · ${i.supplierName}`, supplierId: i.supplierId, orderId }]);
      undoers.set(payment.id, () => {
        payment.orderId = null;
        removeActivity(activityIds);
      });
      const tag = (toOrderSummary(db, db.orders.find((o) => o.id === orderId)!).pendingPayment ?? 1) === 0 ? "pagado" : "pago_parcial";
      return {
        recordId: payment.id,
        title: "Pago imputado",
        subtitle: `${formatMoney(payment.amount)} al pedido ${i.allocation.orderNumber} · ${i.supplierName}`,
        link: { to: "/pedidos/$orderId", params: { orderId } },
        tags: [tag],
      };
    }
  }
  const paymentId = nextId("p");
  const orderId = i.allocation.type === "order" ? i.allocation.orderId : null;
  const orderNumber = i.allocation.type === "order" ? i.allocation.orderNumber : undefined;
  const documentId = i.document ? attachmentToDocument(i.document, "comprobante_pago", i.supplierId, orderId ?? undefined, orderNumber) : undefined;
  db.payments.push({ id: paymentId, supplierId: i.supplierId, orderId, date: i.date, amount: i.amount, method: i.method, documentId });
  const activityIds = addActivity([
    {
      kind: "pago_registrado",
      title: "Pago registrado",
      description: `${formatMoney(i.amount)} · ${i.supplierName} · ${paymentMethodLabel[i.method]}`,
      supplierId: i.supplierId,
      orderId: orderId ?? undefined,
      tags: orderId ? undefined : ["pago_sin_imputar"],
    },
    ...(orderId ? [{ kind: "pago_imputado" as const, title: "Pago imputado", description: `${formatMoney(i.amount)} imputados al pedido ${orderNumber} · ${i.supplierName}`, supplierId: i.supplierId, orderId }] : []),
    ...(i.document ? [{ kind: "documento_agregado" as const, title: "Documento agregado", description: `${i.document.fileName} · Comprobante de pago · ${i.supplierName}`, supplierId: i.supplierId }] : []),
  ]);
  undoers.set(paymentId, () => {
    db.payments = db.payments.filter((p) => p.id !== paymentId);
    db.documents = db.documents.filter((d) => d.id !== documentId);
    removeActivity(activityIds);
  });
  const tag: StatusTag = orderId ? ((toOrderSummary(db, db.orders.find((o) => o.id === orderId)!).pendingPayment ?? 1) === 0 ? "pagado" : "pago_parcial") : "pago_sin_imputar";
  return {
    recordId: paymentId,
    title: "Pago registrado",
    subtitle: `${formatMoney(i.amount)} · ${i.supplierName} · ${paymentMethodLabel[i.method]}`,
    link: orderId ? { to: "/pedidos/$orderId", params: { orderId } } : { to: "/proveedores/$supplierId", params: { supplierId: i.supplierId } },
    tags: [tag],
    documentName: i.document?.fileName,
  };
}

function initialThread(): ChatMessage[] {
  if (db.orders.length === 0) return [];
  const pending = db.pendingDelivery;
  const messages: ChatMessage[] = [
    { id: "m-1", role: "user", at: "2026-10-15T18:38", text: "Pagamos $500.000 de la cuenta corriente de Hierros Córdoba." },
    {
      id: "m-2",
      role: "assistant",
      at: "2026-10-15T18:38",
      blocks: [
        { type: "text", text: "Listo, registré el pago como pago a cuenta corriente, sin imputar a un pedido. El saldo con Hierros Córdoba bajó a $1.500.000." },
        {
          type: "saved_record",
          title: "Pago registrado · Hierros Córdoba",
          subtitle: "$500.000 · Transferencia · 15/10/2026",
          tag: "pago_sin_imputar",
          link: { to: "/proveedores/$supplierId", params: { supplierId: "hierros-cordoba" } },
        },
      ],
    },
  ];
  if (pending) {
    messages.push(
      { id: "m-3", role: "user", at: "2026-10-16T10:02", text: "Llegó esto de Sanitarios del Centro", attachments: pending.document ? [pending.document] : [] },
      {
        id: "m-4",
        role: "assistant",
        at: "2026-10-16T10:02",
        blocks: [
          { type: "text", text: `Es un remito de ${pending.supplierName}. Lo asocié al pedido ${pending.orderNumber}, que todavía no tenía entregas. Revisa antes de guardar:` },
          { type: "interpretation", id: "int-pending-a1043", interpretation: structuredClone(pending), state: "pending" },
        ],
      },
    );
  }
  return messages;
}

const CONVERSATIONS: Conversation[] = [
  { id: "c-1", title: "Entrega de Sanitarios del Centro", date: "2026-10-16", preview: "Remito IMG_2048.jpg · por confirmar" },
  { id: "c-2", title: "Pago a Hierros Córdoba", date: "2026-10-15", preview: "$500.000 a cuenta corriente" },
  { id: "c-3", title: "Segunda entrega del pedido 381", date: "2026-10-13", preview: "10 barras Ø10 · remito 0012-4520" },
  { id: "c-4", title: "Pedido de Sanitarios del Centro", date: "2026-10-10", preview: "A-1043 · 48 caños y 24 codos" },
  { id: "c-5", title: "Pedido 381 a Hierros Córdoba", date: "2026-10-02", preview: "20 barras Ø12 y 30 barras Ø10" },
];

export function createMockAssistant(): AssistantService {
  return {
    async initialThread() {
      await delay(200);
      return { today: db.today, messages: initialThread() };
    },
    async conversations() {
      await delay(250);
      return db.orders.length ? CONVERSATIONS : [];
    },
    async respond(input: AssistantInput, options = {}) {
      const text = input.text?.trim() ?? "";
      const t = norm(text);
      const file = input.attachments?.[0];
      if (file) {
        const kind = classifyAttachment(file, text);
        const supplier = matchSupplier(text) ?? (kind === "delivery" && db.pendingDelivery ? matchSupplier(db.pendingDelivery.supplierName) : undefined) ?? knownSuppliers[0]!;
        await analyze(kind, supplier.name, options.onProgress);
        if (kind === "error") return [{ type: "read_error", fileName: file.fileName }];
        if (kind === "order") {
          const interpretation = orderInterpretation(`${text} ${supplier.name}`, file);
          return [
            { type: "text", text: "Es un comprobante de pedido. Revisa antes de guardar:" },
            { type: "interpretation", id: nextId("int"), interpretation, state: "pending" },
          ];
        }
        if (kind === "payment") return paymentReply(`${text} ${supplier.name} cuenta corriente`, file);
        return deliveryReply(`${text} ${supplier.name}`, file);
      }
      await delay(700);
      if (/imputar el pago/.test(t)) return allocateUnallocated(text);
      if (/cuanto (le )?debemos|saldo|cuanto (le )?debo|deuda/.test(t)) return balanceReply(text);
      if (/pendientes? de entrega|falta (entregar|llegar)|que falta|sin entregar/.test(t)) return pendingDeliveriesReply();
      if (/computo|comparado|llevamos pedido/.test(t)) return computationReply();
      if (/\bpag(amos|ue|o|aron|ado)\b|transferi|abonamos/.test(t)) return paymentReply(text);
      if (/llegaron|llego|entrego|entregaron|recibimos|se entrego|descargaron/.test(t)) return deliveryReply(text);
      if (/pidio|pedimos|encargo|encargamos|compramos|pidieron|pedi\b/.test(t)) {
        const interpretation = orderInterpretation(text);
        return [
          { type: "text", text: `Entendí un pedido a ${interpretation.supplierName}. ${interpretation.flags.includes("precios") ? "Usé los precios del último pedido; revísalos antes de guardar:" : "Revisa antes de guardar:"}` },
          { type: "interpretation", id: nextId("int"), interpretation, state: "pending" },
        ];
      }
      return [
        { type: "text", text: "Puedo registrar pedidos, entregas y pagos, o responder sobre saldos y pendientes. Prueba con algo como «Llegaron las 20 barras del 12» o «¿Cuánto debemos a Hierros Córdoba?»." },
      ];
    },
    async resolveChoice(_choiceId, optionId, context) {
      await delay(450);
      if (optionId === "split") {
        return [{ type: "text", text: "Dime cuánto va a cada pedido, por ejemplo «300 mil al pedido 38 y el resto a cuenta corriente»." }];
      }
      const allocation = optionId.startsWith("order:")
        ? { type: "order" as const, orderId: optionId.slice(6), orderNumber: db.orders.find((o) => o.id === optionId.slice(6))?.number ?? "" }
        : { type: "unallocated" as const };
      return [{ type: "interpretation", id: nextId("int"), interpretation: paymentInterpretation(context.supplierId, context.amount, allocation, []), state: "pending" }];
    },
    async confirm(blockId: ID, interpretation: Interpretation) {
      await delay(650);
      if (interpretation.kind === "order") return confirmOrder(interpretation);
      if (interpretation.kind === "delivery") return confirmDelivery(interpretation);
      return confirmPayment(blockId, interpretation);
    },
    async cancel(blockId: ID) {
      await delay(150);
      if (blockId === "int-pending-a1043") db.pendingDelivery = undefined;
    },
    async undo(recordId: ID) {
      await delay(400);
      undoers.get(recordId)?.();
      undoers.delete(recordId);
    },
  };
}
