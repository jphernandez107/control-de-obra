import type {
  ActivityEvent,
  ComputationChange,
  DocumentRef,
  ID,
  ISODate,
  PaymentMethod,
  PurchaseMode,
  Supplier,
} from "@/domain/types";
import type { DeliveryInterpretation } from "@/domain/assistant";

// Raw, normalized records for the in-memory mock database. Everything the
// UI shows (statuses, balances, progress) is derived from these in `derive.ts`.

export interface DbMaterial {
  id: ID;
  name: string;
  shortName: string;
  category: string;
  unit: string;
  spec?: string;
  supplierId: ID;
}

export interface DbOrderLine {
  id: ID;
  materialId: ID;
  description: string;
  quantity: number;
  unitPrice: number | null;
  amount: number | null;
}

export interface DbOrder {
  id: ID;
  number: string;
  supplierId: ID;
  date: ISODate;
  orderedBy: string;
  orderedByRole?: string;
  mode: PurchaseMode;
  lines: DbOrderLine[];
  documentIds: ID[];
  registeredAt: ISODate;
  registeredVia: "asistente" | "manual";
  notes?: string;
}

export interface DbDelivery {
  id: ID;
  orderId: ID;
  date: ISODate;
  remito: string | null;
  lines: { orderLineId: ID; quantity: number }[];
  documentId?: ID;
}

export interface DbPayment {
  id: ID;
  supplierId: ID;
  orderId: ID | null;
  date: ISODate;
  amount: number;
  method: PaymentMethod;
  documentId?: ID;
}

export interface DbComputation {
  loaded: boolean;
  updatedAt?: ISODate;
  version?: number;
  expected: Record<ID, number>;
  changes: Record<ID, ComputationChange[]>;
  reviewed: ID[];
}

export interface Db {
  today: ISODate;
  suppliers: Supplier[];
  materials: DbMaterial[];
  orders: DbOrder[];
  deliveries: DbDelivery[];
  payments: DbPayment[];
  documents: DocumentRef[];
  computation: DbComputation;
  activity: ActivityEvent[];
  /** Interpretation detected from a document and not yet confirmed. */
  pendingDelivery?: DeliveryInterpretation;
  seq: number;
}

const suppliers: Supplier[] = [
  { id: "hierros-cordoba", name: "Hierros Córdoba", initials: "HC", category: "Hierros", contactName: "Raúl Ferreyra", phone: "351 555-0142" },
  { id: "sanitarios-centro", name: "Sanitarios del Centro", initials: "SC", category: "Sanitarios", contactName: "Gabriela Paz", phone: "351 555-0187" },
  { id: "ladrillera-algarrobo", name: "Ladrillera El Algarrobo", initials: "LA", category: "Ladrillos", contactName: "Oscar Luna", phone: "3543 55-0911" },
  { id: "corralon-san-martin", name: "Corralón San Martín", initials: "CS", category: "Áridos y cementos", contactName: "Diego Sosa", phone: "351 555-0320" },
  { id: "hormigonera-sierras", name: "Hormigonera Sierras", initials: "HS", category: "Hormigón", contactName: "Laura Vélez", phone: "351 555-0476" },
];

const materials: DbMaterial[] = [
  { id: "hierro-12", name: "Hierro Ø12 x 12 m", shortName: "Ø12", category: "Hierros", unit: "barras", spec: "Hierro ADN 420", supplierId: "hierros-cordoba" },
  { id: "hierro-10", name: "Hierro Ø10 x 12 m", shortName: "Ø10", category: "Hierros", unit: "barras", spec: "Hierro ADN 420", supplierId: "hierros-cordoba" },
  { id: "hierro-8", name: "Hierro Ø8 x 12 m", shortName: "Ø8", category: "Hierros", unit: "barras", spec: "Hierro ADN 420", supplierId: "hierros-cordoba" },
  { id: "malla-sima", name: "Malla sima Ø4,2", shortName: "mallas sima", category: "Hierros", unit: "mallas", supplierId: "hierros-cordoba" },
  { id: "cemento", name: "Cemento portland 50 kg", shortName: "cemento", category: "Áridos y cementos", unit: "bolsas", supplierId: "corralon-san-martin" },
  { id: "cal", name: "Cal hidráulica", shortName: "cal", category: "Áridos y cementos", unit: "bolsas", supplierId: "corralon-san-martin" },
  { id: "arena", name: "Arena gruesa", shortName: "arena", category: "Áridos y cementos", unit: "m³", supplierId: "corralon-san-martin" },
  { id: "ladrillo", name: "Ladrillo hueco 12x18x33", shortName: "ladrillos", category: "Ladrillos", unit: "u", supplierId: "ladrillera-algarrobo" },
  { id: "hormigon", name: "Hormigón H21", shortName: "hormigón", category: "Hormigón", unit: "m³", supplierId: "hormigonera-sierras" },
  { id: "cano-pvc", name: "Caño PVC 110 mm", shortName: "caños PVC", category: "Sanitarios", unit: "u", supplierId: "sanitarios-centro" },
  { id: "codo-pvc", name: "Codo PVC 110 mm 90°", shortName: "codos PVC", category: "Sanitarios", unit: "u", supplierId: "sanitarios-centro" },
];

const documents: DocumentRef[] = [
  { id: "doc-381-pedido", fileName: "comprobante_pedido.jpg", kind: "comprobante_pedido", format: "image", sizeLabel: "1,2 MB", date: "2026-10-02", supplierId: "hierros-cordoba", orderId: "o-381", orderNumber: "381" },
  { id: "doc-381-r1", fileName: "remito_4471.pdf", kind: "remito", format: "pdf", sizeLabel: "284 KB", date: "2026-10-06", supplierId: "hierros-cordoba", orderId: "o-381", orderNumber: "381" },
  { id: "doc-381-pago", fileName: "transferencia_0910.png", kind: "comprobante_pago", format: "image", sizeLabel: "640 KB", date: "2026-10-09", supplierId: "hierros-cordoba", orderId: "o-381", orderNumber: "381" },
  { id: "doc-381-r2", fileName: "remito_4520.jpg", kind: "remito", format: "image", sizeLabel: "980 KB", date: "2026-10-13", supplierId: "hierros-cordoba", orderId: "o-381", orderNumber: "381" },
  { id: "doc-hc-1510", fileName: "comprobante_pago_1510.pdf", kind: "comprobante_pago", format: "pdf", sizeLabel: "112 KB", date: "2026-10-15", supplierId: "hierros-cordoba" },
  { id: "doc-352-pedido", fileName: "comprobante_pedido_352.pdf", kind: "comprobante_pedido", format: "pdf", sizeLabel: "198 KB", date: "2026-09-12", supplierId: "hierros-cordoba", orderId: "o-352", orderNumber: "352" },
  { id: "doc-352-r", fileName: "remito_0352.pdf", kind: "remito", format: "pdf", sizeLabel: "240 KB", date: "2026-09-18", supplierId: "hierros-cordoba", orderId: "o-352", orderNumber: "352" },
  { id: "doc-352-pago", fileName: "comprobante_pago_2009.jpg", kind: "comprobante_pago", format: "image", sizeLabel: "720 KB", date: "2026-09-20", supplierId: "hierros-cordoba", orderId: "o-352", orderNumber: "352" },
  { id: "doc-38-pedido", fileName: "pedido_38_ladrillera.jpg", kind: "comprobante_pedido", format: "image", sizeLabel: "1,1 MB", date: "2026-09-29", supplierId: "ladrillera-algarrobo", orderId: "o-38", orderNumber: "38" },
  { id: "doc-38-r", fileName: "remito_2231.jpg", kind: "remito", format: "image", sizeLabel: "860 KB", date: "2026-10-01", supplierId: "ladrillera-algarrobo", orderId: "o-38", orderNumber: "38" },
  { id: "doc-0027-pedido", fileName: "presupuesto_0027.pdf", kind: "comprobante_pedido", format: "pdf", sizeLabel: "156 KB", date: "2026-09-22", supplierId: "corralon-san-martin", orderId: "o-0027", orderNumber: "0027" },
  { id: "doc-0027-pago", fileName: "transferencia_2509.png", kind: "comprobante_pago", format: "image", sizeLabel: "512 KB", date: "2026-09-25", supplierId: "corralon-san-martin", orderId: "o-0027", orderNumber: "0027" },
  { id: "doc-7781-pedido", fileName: "orden_7781.pdf", kind: "comprobante_pedido", format: "pdf", sizeLabel: "210 KB", date: "2026-09-18", supplierId: "hormigonera-sierras", orderId: "o-7781", orderNumber: "7781" },
  { id: "doc-7781-pago", fileName: "transferencia_1909.png", kind: "comprobante_pago", format: "image", sizeLabel: "498 KB", date: "2026-09-19", supplierId: "hormigonera-sierras", orderId: "o-7781", orderNumber: "7781" },
  { id: "doc-31-pedido", fileName: "pedido_31_ladrillera.jpg", kind: "comprobante_pedido", format: "image", sizeLabel: "1,0 MB", date: "2026-09-05", supplierId: "ladrillera-algarrobo", orderId: "o-31", orderNumber: "31" },
  { id: "doc-0035-pedido", fileName: "whatsapp_corralon.txt", kind: "comprobante_pedido", format: "image", sizeLabel: "2 KB", date: "2026-10-15", supplierId: "corralon-san-martin", orderId: "o-0035", orderNumber: "0035" },
  { id: "doc-computo", fileName: "computo_casa_cordoba_v2.xlsx", kind: "computo", format: "pdf", sizeLabel: "86 KB", date: "2026-10-14" },
];

const orders: DbOrder[] = [
  {
    id: "o-0035",
    number: "0035",
    supplierId: "corralon-san-martin",
    date: "2026-10-15",
    orderedBy: "Marcelo Ríos",
    orderedByRole: "ingeniero",
    mode: "cuenta_corriente",
    lines: [{ id: "l-0035-1", materialId: "cemento", description: "Cemento portland 50 kg", quantity: 20, unitPrice: null, amount: null }],
    documentIds: ["doc-0035-pedido"],
    registeredAt: "2026-10-15",
    registeredVia: "asistente",
    notes: "Pedido por WhatsApp. El corralón confirma el precio al entregar.",
  },
  {
    id: "o-381",
    number: "381",
    supplierId: "hierros-cordoba",
    date: "2026-10-02",
    orderedBy: "Marcelo Ríos",
    orderedByRole: "ingeniero",
    mode: "cuenta_corriente",
    lines: [
      { id: "l-381-1", materialId: "hierro-12", description: "Barra Ø12 x 12 m", quantity: 20, unitPrice: 38420, amount: 768400 },
      { id: "l-381-2", materialId: "hierro-10", description: "Barra Ø10 x 12 m", quantity: 30, unitPrice: 23798, amount: 713940 },
    ],
    documentIds: ["doc-381-pedido"],
    registeredAt: "2026-10-02",
    registeredVia: "asistente",
    notes: "Las 5 barras Ø10 faltantes llegan con el próximo envío, según Marcelo.",
  },
  {
    id: "o-a1043",
    number: "A-1043",
    supplierId: "sanitarios-centro",
    date: "2026-10-10",
    orderedBy: "Marcelo Ríos",
    orderedByRole: "ingeniero",
    mode: "cuenta_corriente",
    lines: [
      { id: "l-a1043-1", materialId: "cano-pvc", description: "Caño PVC 110 mm x 4 m", quantity: 48, unitPrice: 11900, amount: 571200 },
      { id: "l-a1043-2", materialId: "codo-pvc", description: "Codo PVC 110 mm 90°", quantity: 24, unitPrice: 1712.5, amount: 41100 },
    ],
    documentIds: [],
    registeredAt: "2026-10-10",
    registeredVia: "asistente",
  },
  {
    id: "o-38",
    number: "38",
    supplierId: "ladrillera-algarrobo",
    date: "2026-09-29",
    orderedBy: "Marcelo Ríos",
    orderedByRole: "ingeniero",
    mode: "cuenta_corriente",
    lines: [{ id: "l-38-1", materialId: "ladrillo", description: "Ladrillo hueco 12x18x33", quantity: 3000, unitPrice: 320, amount: 960000 }],
    documentIds: ["doc-38-pedido"],
    registeredAt: "2026-09-29",
    registeredVia: "asistente",
  },
  {
    id: "o-0027",
    number: "0027",
    supplierId: "corralon-san-martin",
    date: "2026-09-22",
    orderedBy: "Juan Hernández",
    mode: "contado",
    lines: [
      { id: "l-0027-1", materialId: "cemento", description: "Cemento portland 50 kg", quantity: 40, unitPrice: 39750, amount: 1590000 },
      { id: "l-0027-2", materialId: "cal", description: "Cal hidráulica", quantity: 30, unitPrice: 9350, amount: 280500 },
      { id: "l-0027-3", materialId: "arena", description: "Arena gruesa", quantity: 6, unitPrice: 45000, amount: 270000 },
    ],
    documentIds: ["doc-0027-pedido"],
    registeredAt: "2026-09-22",
    registeredVia: "manual",
  },
  {
    id: "o-7781",
    number: "7781",
    supplierId: "hormigonera-sierras",
    date: "2026-09-18",
    orderedBy: "Marcelo Ríos",
    orderedByRole: "ingeniero",
    mode: "contado",
    lines: [{ id: "l-7781-1", materialId: "hormigon", description: "Hormigón H21", quantity: 18, unitPrice: 241667, amount: 4350000 }],
    documentIds: ["doc-7781-pedido"],
    registeredAt: "2026-09-18",
    registeredVia: "asistente",
  },
  {
    id: "o-352",
    number: "352",
    supplierId: "hierros-cordoba",
    date: "2026-09-12",
    orderedBy: "Marcelo Ríos",
    orderedByRole: "ingeniero",
    mode: "cuenta_corriente",
    lines: [
      { id: "l-352-1", materialId: "hierro-12", description: "Barra Ø12 x 12 m", quantity: 60, unitPrice: 18000, amount: 1080000 },
      { id: "l-352-2", materialId: "hierro-10", description: "Barra Ø10 x 12 m", quantity: 20, unitPrice: 12000, amount: 240000 },
      { id: "l-352-3", materialId: "hierro-8", description: "Barra Ø8 x 12 m", quantity: 40, unitPrice: 7000, amount: 280000 },
      { id: "l-352-4", materialId: "malla-sima", description: "Malla sima Ø4,2", quantity: 15, unitPrice: 7844, amount: 117660 },
    ],
    documentIds: ["doc-352-pedido"],
    registeredAt: "2026-09-12",
    registeredVia: "asistente",
  },
  {
    id: "o-31",
    number: "31",
    supplierId: "ladrillera-algarrobo",
    date: "2026-09-05",
    orderedBy: "Juan Hernández",
    mode: "contado",
    lines: [{ id: "l-31-1", materialId: "ladrillo", description: "Ladrillo hueco 12x18x33", quantity: 3000, unitPrice: 300, amount: 900000 }],
    documentIds: ["doc-31-pedido"],
    registeredAt: "2026-09-05",
    registeredVia: "manual",
  },
];

const deliveries: DbDelivery[] = [
  { id: "d-381-2", orderId: "o-381", date: "2026-10-13", remito: "0012-4520", lines: [{ orderLineId: "l-381-2", quantity: 10 }], documentId: "doc-381-r2" },
  { id: "d-381-1", orderId: "o-381", date: "2026-10-06", remito: "0012-4471", lines: [{ orderLineId: "l-381-1", quantity: 20 }, { orderLineId: "l-381-2", quantity: 15 }], documentId: "doc-381-r1" },
  { id: "d-38-1", orderId: "o-38", date: "2026-10-01", remito: "0001-2231", lines: [{ orderLineId: "l-38-1", quantity: 3000 }], documentId: "doc-38-r" },
  { id: "d-0027-1", orderId: "o-0027", date: "2026-09-24", remito: "0004-1180", lines: [{ orderLineId: "l-0027-1", quantity: 40 }, { orderLineId: "l-0027-2", quantity: 30 }, { orderLineId: "l-0027-3", quantity: 6 }] },
  { id: "d-7781-1", orderId: "o-7781", date: "2026-09-19", remito: "R-7781", lines: [{ orderLineId: "l-7781-1", quantity: 18 }] },
  { id: "d-352-1", orderId: "o-352", date: "2026-09-18", remito: "0012-4102", lines: [{ orderLineId: "l-352-1", quantity: 60 }, { orderLineId: "l-352-2", quantity: 20 }, { orderLineId: "l-352-3", quantity: 40 }, { orderLineId: "l-352-4", quantity: 15 }], documentId: "doc-352-r" },
  { id: "d-31-1", orderId: "o-31", date: "2026-09-08", remito: "0001-2104", lines: [{ orderLineId: "l-31-1", quantity: 3000 }] },
];

const payments: DbPayment[] = [
  { id: "p-hc-1510", supplierId: "hierros-cordoba", orderId: null, date: "2026-10-15", amount: 500000, method: "transferencia", documentId: "doc-hc-1510" },
  { id: "p-381-1", supplierId: "hierros-cordoba", orderId: "o-381", date: "2026-10-09", amount: 600000, method: "transferencia", documentId: "doc-381-pago" },
  { id: "p-0027-1", supplierId: "corralon-san-martin", orderId: "o-0027", date: "2026-09-25", amount: 2140500, method: "transferencia", documentId: "doc-0027-pago" },
  { id: "p-352-1", supplierId: "hierros-cordoba", orderId: "o-352", date: "2026-09-20", amount: 600000, method: "transferencia", documentId: "doc-352-pago" },
  { id: "p-7781-1", supplierId: "hormigonera-sierras", orderId: "o-7781", date: "2026-09-19", amount: 4350000, method: "transferencia", documentId: "doc-7781-pago" },
  { id: "p-31-1", supplierId: "ladrillera-algarrobo", orderId: "o-31", date: "2026-09-10", amount: 900000, method: "efectivo" },
];

const computation: DbComputation = {
  loaded: true,
  updatedAt: "2026-10-14",
  version: 2,
  expected: {
    "hierro-12": 90,
    "hierro-10": 45,
    "hierro-8": 120,
    "malla-sima": 30,
    cemento: 300,
    cal: 200,
    arena: 40,
    ladrillo: 6500,
    hormigon: 60,
    "cano-pvc": 48,
  },
  changes: {
    "hierro-10": [{ date: "2026-10-14", before: 40, after: 45, by: "Marcelo Ríos", byRole: "Ingeniero" }],
    "cano-pvc": [{ date: "2026-10-14", before: 42, after: 48, by: "Marcelo Ríos", byRole: "Ingeniero" }],
  },
  reviewed: [],
};

const activity: ActivityEvent[] = [
  {
    id: "a-1",
    kind: "registro_corregido",
    at: "2026-10-16T10:24",
    title: "Registro corregido",
    description: "Pedido 381 · Hierros Córdoba · por Marcelo Ríos",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
    changes: [
      { label: "Barras Ø10 entregadas", before: "30", after: "25" },
      { label: "Remito", before: "0012-452", after: "0012-4520" },
    ],
    reason: "el remito indicaba 10 barras en el segundo envío; faltan 5 por entregar.",
  },
  {
    id: "a-2",
    kind: "documento_agregado",
    at: "2026-10-16T09:15",
    title: "Documento agregado",
    description: "comprobante_pago_1510.pdf · Comprobante de pago · Hierros Córdoba",
    shortDescription: "comprobante_pago_1510.pdf · Hierros Córdoba",
    supplierId: "hierros-cordoba",
  },
  {
    id: "a-3",
    kind: "pago_registrado",
    at: "2026-10-15T18:40",
    title: "Pago registrado",
    description: "$500.000 · Hierros Córdoba · Transferencia",
    shortDescription: "$500.000 · Hierros Córdoba",
    supplierId: "hierros-cordoba",
    tags: ["pago_sin_imputar"],
  },
  {
    id: "a-4",
    kind: "pedido_registrado",
    at: "2026-10-15T11:05",
    title: "Pedido registrado",
    description: "Pedido 0035 · Corralón San Martín · 20 bolsas de cemento · importe a confirmar",
    shortDescription: "Pedido 0035 · Corralón San Martín · sin importe",
    supplierId: "corralon-san-martin",
    orderId: "o-0035",
    tags: ["entrega_pendiente", "sin_pagos"],
  },
  {
    id: "a-5",
    kind: "computo_actualizado",
    at: "2026-10-14T17:30",
    title: "Cómputo actualizado",
    description: "Cómputo v2 · 10 materiales vinculados · por Marcelo Ríos",
    changes: [
      { label: "Hierro Ø10 x 12 m", before: "40 barras", after: "45 barras" },
      { label: "Caño PVC 110 mm", before: "42 u", after: "48 u" },
    ],
  },
  {
    id: "a-6",
    kind: "documento_agregado",
    at: "2026-10-13T16:06",
    title: "Documento agregado",
    description: "remito_4520.jpg · Remito · Hierros Córdoba",
    shortDescription: "remito_4520.jpg · Remito",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
  },
  {
    id: "a-7",
    kind: "entrega_registrada",
    at: "2026-10-13T16:05",
    title: "Entrega registrada",
    description: "Pedido 381 · 10 barras Ø10 · Remito 0012-4520",
    shortDescription: "Pedido 381 · 10 barras Ø10",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
  },
  {
    id: "a-8",
    kind: "pedido_registrado",
    at: "2026-10-10T12:10",
    title: "Pedido registrado",
    description: "Pedido A-1043 · Sanitarios del Centro · 48 caños PVC 110 mm · $612.300",
    shortDescription: "Pedido A-1043 · Sanitarios del Centro · $612.300",
    supplierId: "sanitarios-centro",
    orderId: "o-a1043",
    tags: ["entrega_pendiente", "sin_pagos", "sin_comprobante"],
  },
  {
    id: "a-9",
    kind: "pago_imputado",
    at: "2026-10-09T10:31",
    title: "Pago imputado",
    description: "$600.000 imputados al pedido 381 · Hierros Córdoba",
    shortDescription: "$600.000 al pedido 381",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
  },
  {
    id: "a-10",
    kind: "pago_registrado",
    at: "2026-10-09T10:30",
    title: "Pago registrado",
    description: "$600.000 · Hierros Córdoba · Transferencia",
    shortDescription: "$600.000 · Hierros Córdoba",
    supplierId: "hierros-cordoba",
  },
  {
    id: "a-11",
    kind: "registro_corregido",
    at: "2026-10-07T09:40",
    title: "Registro corregido",
    description: "Pedido 381 · Hierros Córdoba · por Juan Hernández",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
    changes: [{ label: "Precio Ø10", before: "$24.100", after: "$23.798" }],
    reason: "el comprobante tenía el precio con descuento por pago a 30 días.",
  },
  {
    id: "a-12",
    kind: "documento_agregado",
    at: "2026-10-06T15:21",
    title: "Documento agregado",
    description: "remito_4471.pdf · Remito · Hierros Córdoba",
    shortDescription: "remito_4471.pdf · Remito",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
  },
  {
    id: "a-13",
    kind: "entrega_registrada",
    at: "2026-10-06T15:20",
    title: "Entrega registrada",
    description: "Pedido 381 · 20 barras Ø12 y 15 barras Ø10 · Remito 0012-4471",
    shortDescription: "Pedido 381 · 20 barras Ø12 y 15 barras Ø10",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
  },
  {
    id: "a-14",
    kind: "documento_agregado",
    at: "2026-10-02T11:01",
    title: "Documento agregado",
    description: "comprobante_pedido.jpg · Comprobante de pedido · Hierros Córdoba",
    shortDescription: "comprobante_pedido.jpg · Hierros Córdoba",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
  },
  {
    id: "a-15",
    kind: "pedido_registrado",
    at: "2026-10-02T11:00",
    title: "Pedido registrado",
    description: "Pedido 381 · Hierros Córdoba · 2 materiales · $1.482.340",
    shortDescription: "Pedido 381 · Hierros Córdoba · $1.482.340",
    supplierId: "hierros-cordoba",
    orderId: "o-381",
    tags: ["entrega_pendiente", "sin_pagos"],
  },
  {
    id: "a-16",
    kind: "entrega_registrada",
    at: "2026-10-01T09:30",
    title: "Entrega registrada",
    description: "Pedido 38 · 3.000 ladrillos huecos · Remito 0001-2231",
    shortDescription: "Pedido 38 · 3.000 ladrillos huecos",
    supplierId: "ladrillera-algarrobo",
    orderId: "o-38",
  },
  {
    id: "a-17",
    kind: "documento_agregado",
    at: "2026-10-01T09:31",
    title: "Documento agregado",
    description: "remito_2231.jpg · Remito · Ladrillera El Algarrobo",
    shortDescription: "remito_2231.jpg · Remito",
    supplierId: "ladrillera-algarrobo",
    orderId: "o-38",
  },
  {
    id: "a-18",
    kind: "pedido_registrado",
    at: "2026-09-29T08:50",
    title: "Pedido registrado",
    description: "Pedido 38 · Ladrillera El Algarrobo · 3.000 ladrillos · $960.000",
    shortDescription: "Pedido 38 · Ladrillera El Algarrobo",
    supplierId: "ladrillera-algarrobo",
    orderId: "o-38",
  },
  {
    id: "a-19",
    kind: "pago_registrado",
    at: "2026-09-25T13:15",
    title: "Pago registrado",
    description: "$2.140.500 · Corralón San Martín · Transferencia",
    shortDescription: "$2.140.500 · Corralón San Martín",
    supplierId: "corralon-san-martin",
    orderId: "o-0027",
  },
  {
    id: "a-20",
    kind: "entrega_registrada",
    at: "2026-09-24T10:00",
    title: "Entrega registrada",
    description: "Pedido 0027 · cemento, cal y arena · Remito 0004-1180",
    shortDescription: "Pedido 0027 · cemento, cal y arena",
    supplierId: "corralon-san-martin",
    orderId: "o-0027",
  },
  {
    id: "a-21",
    kind: "pedido_registrado",
    at: "2026-09-22T09:20",
    title: "Pedido registrado",
    description: "Pedido 0027 · Corralón San Martín · 3 materiales · $2.140.500",
    shortDescription: "Pedido 0027 · Corralón San Martín",
    supplierId: "corralon-san-martin",
    orderId: "o-0027",
  },
  {
    id: "a-22",
    kind: "pago_imputado",
    at: "2026-09-20T11:02",
    title: "Pago imputado",
    description: "$600.000 imputados al pedido 352 · Hierros Córdoba",
    shortDescription: "$600.000 al pedido 352",
    supplierId: "hierros-cordoba",
    orderId: "o-352",
  },
  {
    id: "a-23",
    kind: "pago_registrado",
    at: "2026-09-20T11:00",
    title: "Pago registrado",
    description: "$600.000 · Hierros Córdoba · Transferencia",
    shortDescription: "$600.000 · Hierros Córdoba",
    supplierId: "hierros-cordoba",
  },
  {
    id: "a-24",
    kind: "entrega_registrada",
    at: "2026-09-19T08:10",
    title: "Entrega registrada",
    description: "Pedido 7781 · 18 m³ de hormigón H21",
    shortDescription: "Pedido 7781 · 18 m³ de hormigón",
    supplierId: "hormigonera-sierras",
    orderId: "o-7781",
  },
  {
    id: "a-25",
    kind: "pago_registrado",
    at: "2026-09-19T08:40",
    title: "Pago registrado",
    description: "$4.350.000 · Hormigonera Sierras · Transferencia",
    shortDescription: "$4.350.000 · Hormigonera Sierras",
    supplierId: "hormigonera-sierras",
    orderId: "o-7781",
  },
  {
    id: "a-26",
    kind: "entrega_registrada",
    at: "2026-09-18T16:30",
    title: "Entrega registrada",
    description: "Pedido 352 · 60 Ø12, 20 Ø10, 40 Ø8 y 15 mallas · Remito 0012-4102",
    shortDescription: "Pedido 352 · entrega completa",
    supplierId: "hierros-cordoba",
    orderId: "o-352",
  },
  {
    id: "a-27",
    kind: "pedido_registrado",
    at: "2026-09-12T10:00",
    title: "Pedido registrado",
    description: "Pedido 352 · Hierros Córdoba · 4 materiales · $1.717.660",
    shortDescription: "Pedido 352 · Hierros Córdoba",
    supplierId: "hierros-cordoba",
    orderId: "o-352",
  },
];

const pendingDelivery: DeliveryInterpretation = {
  kind: "delivery",
  supplierName: "Sanitarios del Centro",
  orderId: "o-a1043",
  orderNumber: "A-1043",
  remito: "0003-00018842",
  date: "2026-10-16",
  items: [
    { orderLineId: "l-a1043-1", material: "Caño PVC 110 mm x 4 m", unit: "u", ordered: 48, before: 0, now: 32 },
    { orderLineId: "l-a1043-2", material: "Codo PVC 110 mm 90°", unit: "u", ordered: 24, before: 0, now: 24 },
  ],
  document: { id: "att-2048", fileName: "IMG_2048.jpg", format: "image", sizeLabel: "1,2 MB" },
  flags: ["remito"],
};

export type Scenario = "en-curso" | "nuevo";

export function createSeed(scenario: Scenario, computationLoaded: boolean): Db {
  if (scenario === "nuevo") {
    return {
      today: "2026-10-02",
      suppliers: [],
      materials: [],
      orders: [],
      deliveries: [],
      payments: [],
      documents: [],
      computation: { loaded: false, expected: {}, changes: {}, reviewed: [] },
      activity: [],
      seq: 1,
    };
  }
  const clone = <T,>(value: T): T => structuredClone(value);
  return {
    today: "2026-10-16",
    suppliers: clone(suppliers),
    materials: clone(materials),
    orders: clone(orders),
    deliveries: clone(deliveries),
    payments: clone(payments),
    documents: clone(documents),
    computation: computationLoaded ? clone(computation) : { loaded: false, expected: {}, changes: {}, reviewed: [] },
    activity: clone(computationLoaded ? activity : activity.filter((a) => a.kind !== "computo_actualizado")),
    pendingDelivery: clone(pendingDelivery),
    seq: 1,
  };
}

/** Catalog used by the assistant mock to recognise suppliers and materials in a new project. */
export const knownSuppliers = suppliers;
export const knownMaterials = materials;
