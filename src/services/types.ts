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
  Supplier,
  SupplierDetail,
  SuppliersOverview,
} from "@/domain/types";
import type {
  AnalysisStep,
  AssistantBlock,
  AssistantInput,
  ChatMessage,
  ConfirmResult,
  Conversation,
  Interpretation,
} from "@/domain/assistant";

// Data-access contracts. Pages and hooks depend only on these interfaces;
// `services/mock` implements them locally until the real API exists.

export interface OrdersService {
  list(): Promise<OrdersOverview>;
  getById(id: ID): Promise<OrderDetail>;
}

export interface SuppliersService {
  list(): Promise<SuppliersOverview>;
  getById(id: ID): Promise<SupplierDetail>;
  options(): Promise<Supplier[]>;
}

export interface MaterialsService {
  overview(): Promise<MaterialsOverview>;
  getById(id: ID): Promise<MaterialDetail>;
  /** Uploads a computation sheet. The mock just marks it as loaded. */
  uploadComputation(file?: File): Promise<void>;
  markReviewed(id: ID): Promise<void>;
  adjustComputation(id: ID, expected: number): Promise<void>;
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

export interface AssistantService {
  /** Current project date plus the conversation so far. */
  initialThread(): Promise<{ today: ISODate; messages: ChatMessage[] }>;
  conversations(): Promise<Conversation[]>;
  respond(input: AssistantInput, options?: AssistantRespondOptions): Promise<AssistantBlock[]>;
  /** Builds the interpretation that follows a disambiguation choice. */
  resolveChoice(choiceId: ID, optionId: ID, context: { supplierId: ID; amount: number }): Promise<AssistantBlock[]>;
  confirm(blockId: ID, interpretation: Interpretation): Promise<ConfirmResult>;
  cancel(blockId: ID): Promise<void>;
  undo(recordId: ID): Promise<void>;
}

export interface Services {
  orders: OrdersService;
  suppliers: SuppliersService;
  materials: MaterialsService;
  activity: ActivityService;
  dashboard: DashboardService;
  assistant: AssistantService;
}
