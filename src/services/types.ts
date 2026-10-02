import type {
  ActivityFilters,
  ActivityPage,
  DashboardSummary,
  ID,
  ISODate,
  MaterialDetail,
  MaterialsOverview,
  OrderDetail,
  OrdersOverview,
  PaymentMethod,
  PurchaseMode,
  Supplier,
  SupplierDetail,
  SuppliersOverview,
} from "@/domain/types";
import type {
  AnalysisStep,
  AssistantBlock,
  AssistantInput,
  ChatMessage,
  ConfirmResponse,
  Conversation,
  Interpretation,
  MatchStatus,
} from "@/domain/assistant";

// Data-access contracts. Pages and hooks depend only on these interfaces;
// `services/api` implements them over the backend HTTP API.
// Money values are integer minor units (centavos) everywhere.

export interface Session {
  today: ISODate;
  user: { userId: ID; name: string; role: string };
  ai: { provider: string; model: string | null };
}

export interface OrderCorrection {
  reference?: string | null;
  date?: ISODate;
  orderedByName?: string | null;
  purchaseMode?: PurchaseMode;
  notes?: string | null;
  statedTotal?: number | null;
  items?: { id: ID; quantity?: number; unitPrice?: number | null }[];
  reason?: string | null;
}

export interface OrdersService {
  list(): Promise<OrdersOverview>;
  getById(id: ID): Promise<OrderDetail>;
  correct(id: ID, correction: OrderCorrection): Promise<OrderDetail>;
  attachDocument(id: ID, documentId: ID): Promise<OrderDetail>;
}

export interface SuppliersService {
  list(): Promise<SuppliersOverview>;
  getById(id: ID): Promise<SupplierDetail>;
  options(): Promise<Supplier[]>;
}

export interface NewDelivery {
  orderId: ID;
  date: ISODate;
  reference?: string | null;
  items: { orderItemId: ID; quantity: number }[];
  documentIds?: ID[];
}

export interface DeliveriesService {
  create(delivery: NewDelivery): Promise<{ deliveryId: ID }>;
}

export interface NewPayment {
  supplierId: ID;
  date: ISODate;
  amount: number;
  method?: PaymentMethod | null;
  reference?: string | null;
  allocations: { orderId: ID; amount: number }[];
  documentIds?: ID[];
}

export interface PaymentsService {
  create(payment: NewPayment): Promise<{ paymentId: ID }>;
  allocate(paymentId: ID, allocations: { orderId: ID; amount: number }[]): Promise<void>;
}

export interface MaterialOption {
  id: ID;
  name: string;
  unit: string;
  unitCode: string;
  category: string;
  aliases: string[];
}

export interface UnitOption {
  code: string;
  label: string;
  singular: string;
  plural: string;
}

export interface ComputationPreviewRow {
  line: number;
  name: string;
  unit: string;
  unitCode: string | null;
  expected: number;
  stage: string | null;
  wastePct: number;
  materialId: ID | null;
  materialName: string | null;
  match: MatchStatus;
  candidates: { id: ID; name: string; unit: string }[];
  ordered: number | null;
  problem: string | null;
}

export interface ComputationPreview {
  documentId: ID;
  fileName: string;
  rows: ComputationPreviewRow[];
}

export interface MaterialsService {
  overview(): Promise<MaterialsOverview>;
  getById(id: ID): Promise<MaterialDetail>;
  options(): Promise<MaterialOption[]>;
  units(): Promise<UnitOption[]>;
  /** Uploads a computation spreadsheet and returns how each row matches the catalog. Writes nothing. */
  previewComputation(file: File): Promise<ComputationPreview>;
  importComputation(documentId: ID, rows: { materialId: ID | null; name: string; unitCode: string; expected: number; stage?: string | null; wastePct?: number }[]): Promise<void>;
  markReviewed(id: ID): Promise<void>;
  adjustComputation(id: ID, expected: number, reason?: string): Promise<void>;
}

export interface UploadedDocument {
  id: ID;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export type DocumentKindCode = "order_proof" | "delivery_proof" | "payment_proof" | "computation" | "other";

export interface DocumentsService {
  upload(file: File, kind?: DocumentKindCode): Promise<UploadedDocument>;
}

export interface ActivityService {
  list(filters?: ActivityFilters): Promise<ActivityPage>;
}

export interface DashboardService {
  summary(): Promise<DashboardSummary>;
}

export interface AssistantRespondOptions {
  /** Called while a document is being read, for the step-by-step loader. */
  onProgress?: (title: string, steps: AnalysisStep[]) => void;
}

export interface AssistantReply {
  conversationId: ID;
  userMessage: ChatMessage;
  reply: ChatMessage;
}

export interface AssistantService {
  /** Current project date plus the latest (or a given) conversation. */
  initialThread(conversationId?: ID): Promise<{ today: ISODate; conversationId: ID | null; messages: ChatMessage[] }>;
  conversations(): Promise<Conversation[]>;
  newConversation(): Promise<{ conversationId: ID }>;
  respond(input: AssistantInput & { conversationId: ID | null; documentIds: ID[] }, options?: AssistantRespondOptions): Promise<AssistantReply>;
  /** Builds the interpretation that follows a disambiguation choice. */
  resolveChoice(input: { conversationId: ID; choiceId: ID; optionId: ID; label: string; context: Extract<AssistantBlock, { type: "choice" }>["context"] }): Promise<{ messages: ChatMessage[] }>;
  /** Re-resolves an edited proposal (matches, balances). Writes nothing. */
  revise(blockId: ID, interpretation: Interpretation): Promise<Interpretation>;
  confirm(blockId: ID, interpretation: Interpretation): Promise<ConfirmResponse>;
  cancel(blockId: ID): Promise<void>;
  undo(recordId: ID, conversationId: ID | null): Promise<{ messages: ChatMessage[] }>;
}

export interface Services {
  session: { get(): Promise<Session> };
  orders: OrdersService;
  suppliers: SuppliersService;
  deliveries: DeliveriesService;
  payments: PaymentsService;
  materials: MaterialsService;
  documents: DocumentsService;
  activity: ActivityService;
  dashboard: DashboardService;
  assistant: AssistantService;
}
