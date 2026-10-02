import type { ActivityFilters, ActivityKind, ActivityPage } from "@/domain/types";
import type {
  ActivityService,
  DashboardService,
  MaterialsService,
  OrdersService,
  Services,
  SuppliersService,
} from "../types";
import { createMockAssistant } from "./assistant";
import {
  byAtDesc,
  dashboard,
  materialsOverview,
  ordersOverview,
  suppliersOverview,
  toMaterialDetail,
  toOrderDetail,
  toSupplierDetail,
} from "./derive";
import { db, delay, nextId, quick, simulated } from "./runtime";

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no encontrado`);
    this.name = "NotFoundError";
  }
}

const orders: OrdersService = {
  list: () => simulated("orders", () => ordersOverview(db)),
  getById: (id) =>
    quick(() => {
      const order = db.orders.find((o) => o.id === id);
      if (!order) throw new NotFoundError("Pedido");
      return toOrderDetail(db, order);
    }, 320),
};

const suppliers: SuppliersService = {
  list: () => simulated("suppliers", () => suppliersOverview(db)),
  getById: (id) =>
    quick(() => {
      if (!db.suppliers.some((s) => s.id === id)) throw new NotFoundError("Proveedor");
      return toSupplierDetail(db, id);
    }, 320),
  options: () => quick(() => db.suppliers, 50),
};

const materials: MaterialsService = {
  overview: () => simulated("materials", () => materialsOverview(db)),
  getById: (id) =>
    quick(() => {
      const material = db.materials.find((m) => m.id === id);
      if (!material) throw new NotFoundError("Material");
      return toMaterialDetail(db, material);
    }, 320),
  async uploadComputation() {
    await delay(1400);
    const defaults: Record<string, number> = {
      "hierro-12": 90, "hierro-10": 45, "hierro-8": 120, "malla-sima": 30, cemento: 300,
      cal: 200, arena: 40, ladrillo: 6500, hormigon: 60, "cano-pvc": 48,
    };
    const version = (db.computation.version ?? 0) + 1;
    db.computation = {
      ...db.computation,
      loaded: true,
      updatedAt: db.today,
      version,
      expected: Object.fromEntries(Object.entries(defaults).filter(([id]) => db.materials.some((m) => m.id === id))),
    };
    db.activity.unshift({
      id: nextId("a"),
      kind: "computo_actualizado",
      at: `${db.today}T${new Date().toTimeString().slice(0, 5)}`,
      title: "Cómputo actualizado",
      description: `Cómputo v${version} · ${Object.keys(db.computation.expected).length} materiales vinculados · por Juan Hernández`,
    });
  },
  async markReviewed(id) {
    await delay(300);
    if (!db.computation.reviewed.includes(id)) db.computation.reviewed.push(id);
  },
  async adjustComputation(id, expected) {
    await delay(400);
    const before = db.computation.expected[id] ?? 0;
    db.computation.expected[id] = expected;
    db.computation.changes[id] = [...(db.computation.changes[id] ?? []), { date: db.today, before, after: expected, by: "Juan Hernández", byRole: "Propietario" }];
    const name = db.materials.find((m) => m.id === id)?.name ?? "Material";
    const unit = db.materials.find((m) => m.id === id)?.unit ?? "u";
    db.activity.unshift({
      id: nextId("a"),
      kind: "computo_actualizado",
      at: `${db.today}T${new Date().toTimeString().slice(0, 5)}`,
      title: "Cómputo actualizado",
      description: `${name} · ajuste manual · por Juan Hernández`,
      changes: [{ label: name, before: `${before} ${unit}`, after: `${expected} ${unit}` }],
    });
  },
};

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const activity: ActivityService = {
  list: (filters: ActivityFilters = {}) =>
    simulated("activity", (): ActivityPage => {
      const q = filters.search ? normalize(filters.search) : "";
      const inRange = db.activity.filter((e) => {
        const day = e.at.slice(0, 10);
        if (filters.from && day < filters.from) return false;
        if (filters.to && day > filters.to) return false;
        if (filters.supplierId && e.supplierId !== filters.supplierId) return false;
        if (q && !normalize(`${e.title} ${e.description}`).includes(q)) return false;
        return true;
      });
      const countsByKind = {
        pedido_registrado: 0, documento_agregado: 0, entrega_registrada: 0, pago_registrado: 0,
        pago_imputado: 0, registro_corregido: 0, computo_actualizado: 0,
      } satisfies Record<ActivityKind, number>;
      for (const e of inRange) countsByKind[e.kind] += 1;
      const events = inRange.filter((e) => !filters.kinds?.length || filters.kinds.includes(e.kind)).sort(byAtDesc);
      return { events, countsByKind, total: events.length };
    }),
};

const dashboardService: DashboardService = {
  summary: () => quick(() => dashboard(db), 260),
};

export function createMockServices(): Services {
  return {
    orders,
    suppliers,
    materials,
    activity,
    dashboard: dashboardService,
    assistant: createMockAssistant(),
  };
}

