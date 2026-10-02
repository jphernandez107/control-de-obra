import type { ID, ISODate, ISODateTime, PaymentMethod, PurchaseMode, StatusTag } from "./types";

export interface Attachment {
  id: ID;
  fileName: string;
  format: "pdf" | "image";
  sizeLabel: string;
  /** Object URL for local previews. */
  previewUrl?: string;
  /** Stored document id once uploaded. */
  documentId?: ID;
  /** Served file URL once uploaded. */
  url?: string;
}

/** How confidently a mention was matched to an existing catalog record. */
export type MatchStatus = "matched" | "suggested" | "new";

export interface MatchOption {
  id: ID;
  name: string;
  unit?: string;
}

/** Field keys the assistant is unsure about and wants the user to verify. */
export type FlaggedField = string;

/** Server validation of a pending AI action, recomputed on every edit and on confirm. */
export interface InterpretationValidation {
  /** ready: can be confirmed · needs_review: has warnings · blocked: cannot be confirmed yet. */
  state: "ready" | "needs_review" | "blocked";
  issues: { field: string; message: string; severity: "warning" | "error" }[];
}

export interface InterpretedOrderItem {
  id: ID;
  /** Catalog material, or `null` to create a new one named `material` on confirm. */
  materialId: ID | null;
  material: string;
  /** Wording heard from the user/document ("barras del 12"). */
  mention?: string;
  match: MatchStatus;
  /** Alternatives when the match is weak and needs the user to choose. */
  candidates?: MatchOption[];
  spec?: string;
  quantity: number;
  unit: string;
  /** Minor units. */
  unitPrice: number | null;
}

export interface OrderInterpretation {
  kind: "order";
  /** Existing supplier, or `null` to create `supplierName` on confirm. */
  supplierId: ID | null;
  supplierName: string;
  supplierMatch: MatchStatus;
  supplierCandidates?: MatchOption[];
  /** External reference; empty when the supplier gave none. */
  number: string;
  date: ISODate;
  orderedBy: string;
  mode: PurchaseMode;
  items: InterpretedOrderItem[];
  /** Total stated without line prices (minor units). */
  statedTotal?: number | null;
  notes?: string;
  document?: Attachment;
  flags: FlaggedField[];
  validation?: InterpretationValidation;
}

export interface InterpretedDeliveryItem {
  orderLineId: ID;
  materialId?: ID;
  material: string;
  unit: string;
  ordered: number;
  before: number;
  now: number;
}

export interface DeliveryInterpretation {
  kind: "delivery";
  supplierId?: ID;
  supplierName: string;
  orderId: ID;
  orderNumber: string;
  remito: string;
  date: ISODate;
  items: InterpretedDeliveryItem[];
  /** "Se entregó todo lo pendiente": confirm re-checks that this still is everything pending. */
  completesOrder?: boolean;
  document?: Attachment;
  flags: FlaggedField[];
  validation?: InterpretationValidation;
}

export type PaymentAllocation =
  /** Whole payment to one order (any excess over its balance stays unallocated). */
  | { type: "order"; orderId: ID; orderNumber: string }
  /** Payment to the supplier's current account, no order. */
  | { type: "unallocated" }
  /** Explicit amounts per order; the remainder stays unallocated. */
  | { type: "split"; parts: { orderId: ID; orderNumber: string; amount: number }[] };

export interface PaymentInterpretation {
  kind: "payment";
  supplierId: ID;
  supplierName: string;
  amount: number;
  date: ISODate;
  method: PaymentMethod;
  allocation: PaymentAllocation;
  /** Before/after figures so the user sees the effect before confirming. */
  preview: {
    orderPendingBefore?: number;
    orderPendingAfter?: number;
    supplierBalanceBefore: number;
    supplierBalanceAfter: number;
    /** Part that will stay unallocated (e.g. excess over the order balance). */
    unallocatedAmount?: number;
    resultingTags?: StatusTag[];
  };
  reference?: string;
  /** Set when this proposal allocates an existing unallocated payment instead of creating one. */
  existingPaymentId?: ID;
  /** "Pagamos completo el pedido X": confirm re-checks that the amount still equals the order balance. */
  paysOrderBalance?: boolean;
  document?: Attachment;
  flags: FlaggedField[];
  validation?: InterpretationValidation;
}

export type Interpretation = OrderInterpretation | DeliveryInterpretation | PaymentInterpretation;

export type InterpretationState = "pending" | "confirming" | "confirmed" | "cancelled";

export interface ConfirmResult {
  recordId: ID;
  title: string;
  subtitle: string;
  link: { to: "/pedidos/$orderId"; params: { orderId: string } } | { to: "/proveedores/$supplierId"; params: { supplierId: string } };
  total?: number;
  tags: StatusTag[];
  documentName?: string;
}

export interface AnalysisStep {
  label: string;
  state: "done" | "active" | "todo";
}

export interface ChoiceOption {
  id: ID;
  title: string;
  description: string;
}

export interface BalanceRow {
  label: string;
  description: string;
  /** `null` when the order value is still unknown. */
  amount: number | null;
  unallocated?: boolean;
  orderId?: ID;
}

export interface QuantityRow {
  material: string;
  ordered: number;
  delivered: number;
  unit: string;
}

export interface SuggestedAction {
  label: string;
  icon: "git-fork" | "store" | "upload" | "clipboard-list" | "truck";
  prompt?: string;
  link?: { to: "/proveedores/$supplierId"; params: { supplierId: string } } | { to: "/materiales" } | { to: "/pedidos" };
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "interpretation"; id: ID; interpretation: Interpretation; state: InterpretationState; result?: ConfirmResult }
  | { type: "analysis"; title: string; steps: AnalysisStep[] }
  | {
      type: "choice";
      id: ID;
      options: ChoiceOption[];
      selected: ID;
      warning?: string;
      /** Resolved once the user continues. */
      resolved?: boolean;
      context: { supplierId: ID; amount: number; date?: ISODate; method?: PaymentMethod; documentId?: ID };
    }
  | { type: "read_error"; fileName: string }
  /** AI provider/document failure (codes: AI_NOT_CONFIGURED, AI_PROVIDER_UNAVAILABLE, AI_QUOTA_EXCEEDED, AI_INVALID_RESPONSE, AI_DOCUMENT_UNSUPPORTED, AI_INTERPRETATION_AMBIGUOUS). */
  | { type: "ai_error"; code: string; message: string; hint?: string }
  | {
      type: "balance";
      supplierId: ID;
      ordered: number;
      paid: number;
      balance: number;
      allocatedPaid: number;
      unallocatedPaid: number;
      rows: BalanceRow[];
    }
  | { type: "quantities"; rows: QuantityRow[]; computationPrompt: boolean }
  | {
      type: "pending_deliveries";
      rows: { orderId: ID; orderNumber: string; supplier: string; pendingLabel: string }[];
    }
  | { type: "saved_record"; title: string; subtitle: string; tag?: StatusTag; link?: ConfirmResult["link"] }
  | { type: "actions"; actions: SuggestedAction[] }
  | { type: "note"; text: string };

export interface ChatMessage {
  id: ID;
  role: "user" | "assistant";
  at: ISODateTime;
  text?: string;
  attachments?: Attachment[];
  blocks?: AssistantBlock[];
  /** Label rendered next to the assistant avatar while it works. */
  status?: string;
}

export interface AssistantInput {
  text?: string;
  attachments?: Attachment[];
}

export interface ConfirmResponse {
  result: ConfirmResult;
  /** Messages the server appended to the conversation (echo + result card). */
  messages: ChatMessage[];
}

export interface Conversation {
  id: ID;
  title: string;
  date: ISODate;
  preview: string;
}
