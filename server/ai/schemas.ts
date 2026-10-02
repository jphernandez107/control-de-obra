import { z } from "zod";

// Application-owned contract for what any AI provider must return. Providers
// only *extract* what the user or document says (mentions, quantities,
// amounts); resolving mentions to records and computing balances is done by
// the application. Every provider response is validated with this schema.

export const INTENTS = [
  "create_order",
  "register_delivery",
  "complete_order_delivery",
  "create_payment",
  "pay_order_balance",
  "record_supplier_account_payment",
  "allocate_payment",
  "ask_query",
  "unknown",
] as const;

export const QUERY_TYPES = [
  "supplier_balance",
  "total_balance",
  "pending_deliveries",
  "material_quantity",
  "computation_status",
  "order_status",
  "unallocated_payments",
  "general",
] as const;

export const DOCUMENT_TYPES = ["order_proof", "delivery_proof", "payment_proof", "other", "unreadable"] as const;

export const ExtractedItemSchema = z.object({
  /** Material exactly as written/said ("barras del 12", "Acero Ø12", "cemento"). */
  material: z.string(),
  /** Quantity; null when not stated. */
  quantity: z.number().nullable(),
  /** Unit word as written ("barras", "bolsas", "m3"); null when not stated. */
  unit: z.string().nullable(),
  /** Unit price in pesos when stated; never guessed. */
  unitPrice: z.number().nullable(),
});

export const ExtractionSchema = z.object({
  intent: z.enum(INTENTS),
  /** 0–1: how sure the provider is about the intent and fields. */
  confidence: z.number(),
  documentType: z.enum(DOCUMENT_TYPES).nullable(),
  supplier: z.string().nullable(),
  /** Order number/reference mentioned ("38", "A-1043"). */
  orderReference: z.string().nullable(),
  /** Remito / delivery-note number. */
  remito: z.string().nullable(),
  /** YYYY-MM-DD when a date is stated or implied ("ayer"). */
  date: z.string().nullable(),
  orderedBy: z.string().nullable(),
  purchaseMode: z.enum(["cuenta_corriente", "contado"]).nullable(),
  items: z.array(ExtractedItemSchema),
  /** "Se entregó todo lo pendiente" / "llegó el resto". */
  deliverAllPending: z.boolean(),
  /** Payment amount in pesos when stated. */
  amount: z.number().nullable(),
  /** Order total in pesos when stated without line prices. */
  orderTotal: z.number().nullable(),
  paymentMethod: z.enum(["transferencia", "efectivo", "cheque", "otro"]).nullable(),
  paymentReference: z.string().nullable(),
  /** "Pagamos completo el pedido 27". */
  paysFullOrderBalance: z.boolean(),
  /** Explicitly to the supplier's current account, not to an order. */
  toCurrentAccount: z.boolean(),
  /** Explicit split of a payment across orders. */
  allocations: z.array(z.object({ orderReference: z.string(), amount: z.number().nullable() })),
  query: z
    .object({
      type: z.enum(QUERY_TYPES),
      supplier: z.string().nullable(),
      material: z.string().nullable(),
      orderReference: z.string().nullable(),
    })
    .nullable(),
  /** Short note in Spanish when something is unclear or missing. */
  note: z.string().nullable(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type Intent = (typeof INTENTS)[number];

export const AnswerSchema = z.object({ text: z.string() });
export type AIAnswer = z.infer<typeof AnswerSchema>;

export function emptyExtraction(intent: Intent = "unknown"): Extraction {
  return {
    intent,
    confidence: 0,
    documentType: null,
    supplier: null,
    orderReference: null,
    remito: null,
    date: null,
    orderedBy: null,
    purchaseMode: null,
    items: [],
    deliverAllPending: false,
    amount: null,
    orderTotal: null,
    paymentMethod: null,
    paymentReference: null,
    paysFullOrderBalance: false,
    toCurrentAccount: false,
    allocations: [],
    query: null,
    note: null,
  };
}
