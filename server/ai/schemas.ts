import { z } from "zod";
import { AIError } from "./errors";
import { MATERIAL_METRICS } from "./question-semantics";

// Application-owned contract for what any AI provider must return. Providers
// only *extract* what the user or a document says (mentions, quantities,
// amounts) and classify the intent; resolving mentions to records and
// computing remaining quantities or balances is done by the application.
//
// Every provider response goes through `parseInterpretationResult` before it
// reaches the proposal builders, so malformed output can never reach a
// domain command. The schemas have no transforms, so `interpretationJsonSchema`
// can be handed to a model as a structured-output / JSON-mode schema.

export const PROJECT_QUERY_NAMES = [
  "get_supplier_summary",
  "list_supplier_balances",
  "get_order_summary",
  "list_orders_pending_delivery",
  "list_delivered_unpaid_orders",
  "get_material_summary",
  "get_computation_variance",
  "list_unallocated_payments",
  "search_materials",
  "get_material_order_summary",
  "get_material_delivery_summary",
  "get_material_history",
  "get_order_items",
  "search_order_items",
  "get_computation_comparison",
] as const;

export type ProjectQueryName = (typeof PROJECT_QUERY_NAMES)[number];

/** Supporting documents the application handles. There is deliberately no invoice type. */
export const DOCUMENT_TYPES = ["order", "delivery", "payment", "unknown"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const PAYMENT_METHODS = ["transferencia", "efectivo", "cheque", "otro"] as const;

const optionalText = (max = 200) => z.string().max(max).nullable();
/** YYYY-MM-DD, already resolved from "hoy"/"ayer" by the provider using the given date. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
/** Pesos as written (500.000 → 500000). Converted to integer minor units by the application. */
const amount = z.number().positive().nullable();

const base = {
  /** 0–1: how sure the provider is about the intent and the extracted fields. */
  confidence: z.number().min(0).max(1),
  /** Short Spanish note when something is unclear or missing; never shown as a fact. */
  note: optionalText(500),
};

export const ItemMentionSchema = z.object({
  /** Material exactly as written/said ("barras del 12", "HIERRO DIAM.12 X BARRA 12 MT", "cemento"). */
  material: z.string().min(1).max(120),
  /** How many purchase units: for "HIERRO DIAM.12 X BARRA 12 MT · cantidad 172" it is 172 (bars), not meters. */
  quantity: z.number().positive().nullable(),
  /** Purchase unit word as written ("barras", "bolsas", "m3", "kg"). The unit of `quantity`. */
  unit: optionalText(40),
  /** Size of ONE purchase unit when the description states it: "X BARRA 12 MT" → 12; "bolsa x 50 kg" → 50. */
  unitSize: z.number().positive().nullable().optional(),
  /** Unit of `unitSize` ("m", "kg"). */
  unitSizeUnit: optionalText(20).optional(),
  /** Price of one purchase unit in pesos, only when explicitly stated. */
  unitPrice: z.number().nonnegative().nullable(),
});

export const DeliveredItemSchema = z.object({
  material: z.string().min(1).max(120),
  quantity: z.number().positive(),
  unit: optionalText(40),
});

export const CreateOrderSchema = z.object({
  intent: z.literal("create_order"),
  ...base,
  supplier: optionalText(),
  /** External order reference as said or printed ("38", "A-1043"). */
  orderReference: optionalText(60),
  date: isoDate,
  requestedBy: optionalText(80),
  purchaseMode: z.enum(["cuenta_corriente", "contado"]).nullable(),
  items: z.array(ItemMentionSchema).max(60),
  /** Total stated by the supplier when there are no line prices. */
  orderTotal: z.number().nonnegative().nullable(),
});

export const RegisterDeliverySchema = z.object({
  intent: z.literal("register_delivery"),
  ...base,
  orderReference: optionalText(60),
  supplier: optionalText(),
  /** Remito / delivery-note number. */
  deliveryReference: optionalText(60),
  date: isoDate,
  items: z.array(DeliveredItemSchema).max(60),
});

/** "Se entregó todo lo pendiente del pedido 38": the application computes what was pending. */
export const CompleteOrderDeliverySchema = z.object({
  intent: z.literal("complete_order_delivery"),
  ...base,
  orderReference: optionalText(60),
  supplier: optionalText(),
  deliveryReference: optionalText(60),
  date: isoDate,
});

export const CreateSupplierPaymentSchema = z.object({
  intent: z.literal("create_supplier_payment"),
  ...base,
  supplier: optionalText(),
  amount,
  currency: z.enum(["ARS", "USD"]).nullable(),
  date: isoDate,
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  paymentReference: optionalText(80),
  /** Said explicitly that it goes to the current account, not to an order. */
  toCurrentAccount: z.boolean(),
  /** Order the payment is for, when said. Optional: payments need no order. */
  orderReference: optionalText(60),
  /** Explicit split across orders ("300 mil al 38 y 200 mil al 41"). */
  allocations: z.array(z.object({ orderReference: z.string().min(1).max(60), amount })).max(10),
});

/** "Pagamos completo el pedido 38": the application computes the outstanding amount. */
export const PayOrderBalanceSchema = z.object({
  intent: z.literal("pay_order_balance"),
  ...base,
  orderReference: optionalText(60),
  supplier: optionalText(),
  date: isoDate,
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  paymentReference: optionalText(80),
});

/** Allocate an existing unallocated payment to an order. */
export const AllocatePaymentSchema = z.object({
  intent: z.literal("allocate_payment"),
  ...base,
  supplier: optionalText(),
  orderReference: optionalText(60),
  amount,
});

export const ProjectQuestionSchema = z.object({
  intent: z.literal("ask_project_question"),
  ...base,
  /** Narrow read-only query that answers the question; "general" when none fits. */
  query: z.enum([...PROJECT_QUERY_NAMES, "general"]),
  supplier: optionalText(),
  orderReference: optionalText(60),
  material: optionalText(120),
  /** For order questions: what the user cares about. */
  aspect: z.enum(["overall", "delivery", "payment"]).nullable(),
  /**
   * For material questions, the exact fact asked: ordered_quantity ("¿cuántas se pidieron?"),
   * delivered_quantity ("¿cuántas llegaron?"), pending_delivery_quantity ("¿cuántas faltan que lleguen?"),
   * expected_quantity ("¿cuántas necesitamos?", cómputo), remaining_to_order_quantity ("¿cuánto falta pedir?"),
   * ordered_amount ("¿cuánto salió?"), unit_price ("¿cuánto costó cada una?"), purchase_history.
   */
  metric: z.enum(MATERIAL_METRICS).nullable().optional(),
  /** Unit the answer is asked in, as written ("metros lineales", "kilos", "barras"). */
  unit: optionalText(40).optional(),
  /** "¿Y cuánto falta pagar?": refers to the entity of the previous exchange. */
  refersToPrevious: z.boolean(),
});

export const WRITE_INTENTS = ["create_order", "register_delivery", "complete_order_delivery", "create_supplier_payment", "pay_order_balance", "allocate_payment"] as const;

export const ClarificationSchema = z.object({
  intent: z.literal("clarification_required"),
  ...base,
  /** Spanish question to ask the user. */
  question: z.string().min(1).max(300),
  possibleIntent: z.enum([...WRITE_INTENTS, "ask_project_question"]).nullable(),
  /** Field names that are missing ("supplier", "amount", "orderReference"). */
  missing: z.array(z.string().max(60)).max(10),
});

export const UnknownIntentSchema = z.object({
  intent: z.literal("unknown"),
  ...base,
});

export const AIInterpretationSchema = z.discriminatedUnion("intent", [
  CreateOrderSchema,
  RegisterDeliverySchema,
  CompleteOrderDeliverySchema,
  CreateSupplierPaymentSchema,
  PayOrderBalanceSchema,
  AllocatePaymentSchema,
  ProjectQuestionSchema,
  ClarificationSchema,
  UnknownIntentSchema,
]);

export const DocumentClassificationSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  /** 0–1: how sure the provider is about the classification and the reading. */
  confidence: z.number().min(0).max(1),
});

/** What `interpret` / `analyzeDocument` return. `document` is null for plain messages. */
export const AIInterpretationResultSchema = z.object({
  interpretation: AIInterpretationSchema,
  document: DocumentClassificationSchema.nullable(),
});

export const AIAnswerSchema = z.object({ text: z.string().min(1).max(4000) });

export type ItemMention = z.infer<typeof ItemMentionSchema>;
export type CreateOrderIntent = z.infer<typeof CreateOrderSchema>;
export type RegisterDeliveryIntent = z.infer<typeof RegisterDeliverySchema>;
export type CompleteOrderDeliveryIntent = z.infer<typeof CompleteOrderDeliverySchema>;
export type CreateSupplierPaymentIntent = z.infer<typeof CreateSupplierPaymentSchema>;
export type PayOrderBalanceIntent = z.infer<typeof PayOrderBalanceSchema>;
export type AllocatePaymentIntent = z.infer<typeof AllocatePaymentSchema>;
export type ProjectQuestion = z.infer<typeof ProjectQuestionSchema>;
export type ClarificationRequest = z.infer<typeof ClarificationSchema>;
export type UnknownIntent = z.infer<typeof UnknownIntentSchema>;
export type AIInterpretation = z.infer<typeof AIInterpretationSchema>;
export type IntentName = AIInterpretation["intent"];
export type DocumentClassification = z.infer<typeof DocumentClassificationSchema>;

/** Optional provider metadata, stored with the pending action for auditing. Never vendor response objects. */
export interface AIProviderMeta {
  provider: string;
  model?: string;
  latencyMs?: number;
}

export interface AIInterpretationResult {
  interpretation: AIInterpretation;
  document: DocumentClassification | null;
  meta?: AIProviderMeta;
}

export interface AIAnswerResult {
  text: string;
  meta?: AIProviderMeta;
}

/** Trims strings and turns empty strings into null, so "" never reads as a value. */
function tidy(value: unknown): unknown {
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  if (Array.isArray(value)) return value.map(tidy);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidy(v)]));
  return value;
}

/** Validates raw provider output. Anything that does not match the contract becomes AI_INVALID_RESPONSE. */
export function parseInterpretationResult(raw: unknown): AIInterpretationResult {
  const meta = raw && typeof raw === "object" && "meta" in raw ? (raw as { meta?: AIProviderMeta }).meta : undefined;
  const parsed = AIInterpretationResultSchema.safeParse(tidy(raw && typeof raw === "object" ? { ...(raw as object), meta: undefined } : raw));
  if (!parsed.success) throw new AIError("AI_INVALID_RESPONSE", undefined, parsed.error.issues);
  return { ...parsed.data, meta };
}

export function parseAnswerResult(raw: unknown): AIAnswerResult {
  const meta = raw && typeof raw === "object" && "meta" in raw ? (raw as { meta?: AIProviderMeta }).meta : undefined;
  const parsed = AIAnswerSchema.safeParse(tidy(raw && typeof raw === "object" ? { ...(raw as object), meta: undefined } : raw));
  if (!parsed.success) throw new AIError("AI_INVALID_RESPONSE", undefined, parsed.error.issues);
  return { text: parsed.data.text, meta };
}

/** JSON Schema of the provider contract, for JSON-mode / structured-output requests. */
export function interpretationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AIInterpretationResultSchema) as Record<string, unknown>;
}

export function answerJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AIAnswerSchema) as Record<string, unknown>;
}
