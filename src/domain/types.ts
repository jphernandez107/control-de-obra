// Frontend-facing domain types. The backend will own persistence and
// derivations; these shapes describe what the UI needs to render.

export type ID = string;
/** Calendar date, `YYYY-MM-DD`. */
export type ISODate = string;
/** Date-time, `YYYY-MM-DDTHH:mm`. */
export type ISODateTime = string;

export type DeliveryStatus = "pendiente" | "parcial" | "entregado";
export type PaymentStatus = "sin_pagos" | "parcial" | "pagado";
export type PaymentMethod = "transferencia" | "efectivo" | "cheque" | "otro";
export type PurchaseMode = "cuenta_corriente" | "contado";
export type DocumentKind = "comprobante_pedido" | "remito" | "comprobante_pago" | "computo" | "otro";
export type DocumentFormat = "pdf" | "image";

export interface SupplierRef {
  id: ID;
  name: string;
}

export interface Supplier extends SupplierRef {
  initials: string;
  category: string;
  contactName?: string;
  phone?: string;
}

export interface SupplierSummary extends Supplier {
  totalOrdered: number;
  totalPaid: number;
  /** totalOrdered − every payment, including unallocated ones. */
  balance: number;
  unallocatedPaid: number;
  openOrders: number;
  pendingDeliveries: number;
  ordersWithoutDocument: number;
}

export interface DocumentRef {
  id: ID;
  fileName: string;
  kind: DocumentKind;
  format: DocumentFormat;
  sizeLabel: string;
  date: ISODate;
  supplierId?: ID;
  orderId?: ID;
  orderNumber?: string;
}

export interface OrderLine {
  id: ID;
  materialId: ID;
  materialName: string;
  spec?: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  amount: number | null;
  delivered: number;
}

export interface DeliveryLine {
  orderLineId: ID;
  materialName: string;
  quantity: number;
  unit: string;
}

export interface Delivery {
  id: ID;
  orderId: ID;
  date: ISODate;
  remito: string | null;
  lines: DeliveryLine[];
  document?: DocumentRef;
}

export interface Payment {
  id: ID;
  supplierId: ID;
  /** `null` = payment to the current account, not allocated to an order. */
  orderId: ID | null;
  orderNumber?: string;
  date: ISODate;
  amount: number;
  method: PaymentMethod;
  document?: DocumentRef;
}

export interface DeliveryProgress {
  status: DeliveryStatus;
  ordered: number;
  delivered: number;
  /** Shared unit when every line uses the same one, otherwise "u". */
  unit: string;
  pendingLabel?: string;
}

export interface PaymentProgress {
  status: PaymentStatus;
  paid: number;
  /** 0–100, `null` when the order value is unknown. */
  percent: number | null;
}

export interface OrderSummary {
  id: ID;
  number: string;
  supplier: SupplierRef;
  date: ISODate;
  itemsLabel: string;
  materialNames: string[];
  /** `null` when the order value is not known yet. */
  total: number | null;
  pendingPayment: number | null;
  delivery: DeliveryProgress;
  payment: PaymentProgress;
  hasDocument: boolean;
  /** An interpreted delivery is waiting for confirmation in the assistant. */
  deliveryAwaitingConfirmation?: boolean;
}

export interface OrderDetail extends OrderSummary {
  orderedBy: string;
  orderedByRole?: string;
  mode: PurchaseMode;
  registeredAt: ISODate;
  registeredVia: "asistente" | "manual";
  lines: OrderLine[];
  deliveries: Delivery[];
  payments: Payment[];
  documents: DocumentRef[];
  history: ActivityEvent[];
  notes?: string;
  /** Unallocated payments the supplier has on its current account. */
  supplierUnallocated: number;
}

export interface LedgerEntry {
  id: ID;
  date: ISODate;
  type: "pedido" | "pago";
  title: string;
  description: string;
  orderAmount?: number;
  paymentAmount?: number;
  unallocated?: boolean;
  runningBalance: number;
  orderId?: ID;
}

export interface PendingDeliveryLine {
  orderId: ID;
  orderNumber: string;
  materialName: string;
  ordered: number;
  delivered: number;
  unit: string;
  lastDeliveryDate?: ISODate;
}

export interface SupplierDetail extends SupplierSummary {
  openOrderList: (OrderSummary & { linesLabel: string; paid: number })[];
  pendingDeliveryLines: PendingDeliveryLine[];
  /** Grouped by order: lines already fully delivered are also listed for context. */
  deliveryOrders: { orderId: ID; orderNumber: string; status: DeliveryStatus; lines: PendingDeliveryLine[] }[];
  unallocatedPayments: Payment[];
  ledger: LedgerEntry[];
  documents: DocumentRef[];
  allocatedPaid: number;
}

export type ComputationStatus = "sin_computo" | "dentro" | "cerca" | "alcanzado" | "supera";

export interface MaterialComputation {
  expected: number;
  percent: number;
  remaining: number;
  variation: number;
  status: Exclude<ComputationStatus, "sin_computo">;
}

export interface MaterialSummary {
  id: ID;
  name: string;
  category: string;
  unit: string;
  supplierName: string;
  ordered: number;
  delivered: number;
  pendingDelivery: number;
  lastOrderDate: ISODate;
  computation: MaterialComputation | null;
}

export interface MaterialOrderRow {
  orderId: ID;
  orderNumber: string;
  date: ISODate;
  delivery: DeliveryStatus;
  payment: PaymentStatus;
  ordered: number;
  delivered: number;
  cumulative: number;
}

export interface MaterialDeliveryRow {
  id: ID;
  label: string;
  date: ISODate | null;
  quantity: number;
  pending: boolean;
}

export interface ComputationChange {
  date: ISODate;
  before: number;
  after: number;
  by: string;
  byRole?: string;
}

export interface MaterialDetail extends MaterialSummary {
  spec?: string;
  usualSupplier: string;
  orders: MaterialOrderRow[];
  deliveries: MaterialDeliveryRow[];
  computationChanges: ComputationChange[];
  reviewed: boolean;
}

export interface ComputationInfo {
  loaded: boolean;
  updatedAt?: ISODate;
  linkedMaterials?: number;
  version?: number;
}

export interface MaterialsOverview {
  computation: ComputationInfo;
  materials: MaterialSummary[];
  orderCount: number;
  counts: Record<Exclude<ComputationStatus, "sin_computo">, number> & { sin_computo: number };
}

export type ActivityKind =
  | "pedido_registrado"
  | "documento_agregado"
  | "entrega_registrada"
  | "pago_registrado"
  | "pago_imputado"
  | "registro_corregido"
  | "computo_actualizado";

export type StatusTag =
  | "entrega_pendiente"
  | "entrega_parcial"
  | "entregado"
  | "sin_pagos"
  | "pago_parcial"
  | "pagado"
  | "pago_sin_imputar"
  | "sin_comprobante"
  | "computo_cerca"
  | "computo_supera"
  | "computo_alcanzado"
  | "por_confirmar";

export interface ActivityChange {
  label: string;
  before: string;
  after: string;
}

export interface ActivityEvent {
  id: ID;
  kind: ActivityKind;
  at: ISODateTime;
  title: string;
  description: string;
  /** Shorter description for narrow layouts. */
  shortDescription?: string;
  supplierId?: ID;
  orderId?: ID;
  changes?: ActivityChange[];
  reason?: string;
  tags?: StatusTag[];
}

export type AttentionKind =
  | "por_confirmar"
  | "computo_supera"
  | "computo_cerca"
  | "computo_alcanzado"
  | "entrega_parcial"
  | "entregado_sin_pagos"
  | "pago_sin_imputar"
  | "sin_comprobante";

export type AttentionGroup = "confirmar" | "computo" | "entregas" | "pagos" | "documentos";

export interface AttentionItem {
  id: ID;
  kind: AttentionKind;
  group: AttentionGroup;
  title: string;
  description: string;
  /** Compact chip label for the mobile assistant header. */
  chip?: string;
  link?: AppLink;
}

export type AppLink =
  | { to: "/pedidos/$orderId"; params: { orderId: string } }
  | { to: "/proveedores/$supplierId"; params: { supplierId: string } }
  | { to: "/materiales/$materialId"; params: { materialId: string } }
  | { to: "/" }
  | { to: "/pedidos" }
  | { to: "/materiales" }
  | { to: "/actividad" };

export interface DashboardSummary {
  totalBalance: number;
  suppliersWithBalance: number;
  unallocatedTotal: number;
  attention: AttentionItem[];
  recentActivity: ActivityEvent[];
  computation: ComputationInfo;
  hasData: boolean;
}

export interface ActivityFilters {
  search?: string;
  kinds?: ActivityKind[];
  supplierId?: ID;
  from?: ISODate;
  to?: ISODate;
}

export interface ActivityPage {
  events: ActivityEvent[];
  countsByKind: Record<ActivityKind, number>;
  total: number;
}

export interface OrdersOverview {
  orders: OrderSummary[];
  supplierCount: number;
  firstOrderDate?: ISODate;
  totalOrdered: number;
  unknownValueCount: number;
  pendingDeliveryCount: number;
  pendingDeliveryLabel: string;
  pendingPaymentTotal: number;
  pendingPaymentCount: number;
  unallocatedTotal: number;
  unallocatedSuppliers: string[];
}

export interface SuppliersOverview {
  suppliers: SupplierSummary[];
  orderCount: number;
  totalOrdered: number;
  totalPaid: number;
  totalBalance: number;
  unallocatedTotal: number;
}
