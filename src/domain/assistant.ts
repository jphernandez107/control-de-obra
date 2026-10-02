import type { ID, ISODate, ISODateTime, PaymentMethod, PurchaseMode, StatusTag } from "./types";

export interface Attachment {
  id: ID;
  fileName: string;
  format: "pdf" | "image";
  sizeLabel: string;
  /** Object URL for local previews. */
  previewUrl?: string;
}

/** Field keys the assistant is unsure about and wants the user to verify. */
export type FlaggedField = string;

export interface InterpretedOrderItem {
  id: ID;
  material: string;
  spec?: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
}

export interface OrderInterpretation {
  kind: "order";
  supplierName: string;
  number: string;
  date: ISODate;
  orderedBy: string;
  mode: PurchaseMode;
  items: InterpretedOrderItem[];
  document?: Attachment;
  flags: FlaggedField[];
}

export interface InterpretedDeliveryItem {
  orderLineId: ID;
  material: string;
  unit: string;
  ordered: number;
  before: number;
  now: number;
}

export interface DeliveryInterpretation {
  kind: "delivery";
  supplierName: string;
  orderId: ID;
  orderNumber: string;
  remito: string;
  date: ISODate;
  items: InterpretedDeliveryItem[];
  document?: Attachment;
  flags: FlaggedField[];
}

export type PaymentAllocation =
  | { type: "order"; orderId: ID; orderNumber: string }
  | { type: "unallocated" };

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
    resultingTags?: StatusTag[];
  };
  document?: Attachment;
  flags: FlaggedField[];
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
  amount: number;
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
      context: { supplierId: ID; amount: number };
    }
  | { type: "read_error"; fileName: string }
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

export interface Conversation {
  id: ID;
  title: string;
  date: ISODate;
  preview: string;
}
