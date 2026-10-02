import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { AppDb } from "./db/client";
import * as t from "./db/schema";
import { CONVERSIONS, MATERIALS, SUPPLIERS, UNITS } from "./dev/catalog";
import { simplePdf } from "./dev/pdf";
import { addDays, localDate } from "./domain/time";
import { normalizeText } from "./domain/text";
import { toMilli } from "./domain/quantity";
import * as commands from "./services/commands";
import { newId, type Actor, type CommandContext } from "./services/context";
import { storeDocument } from "./services/documents";
import type { DocumentStorage } from "./storage/storage";

// Demo data. The project history is replayed through the real domain
// commands (with back-dated clocks), so statuses, balances and the audit log
// are produced by the same code paths the app uses.

const TZ = "America/Argentina/Cordoba";

export interface SeedOptions {
  /** Only project, users, units and catalog — no orders, deliveries or payments. */
  empty?: boolean;
  now?: Date;
}

export async function seedDatabase(db: AppDb, storage: DocumentStorage, options: SeedOptions = {}) {
  const realNow = options.now ?? new Date();
  const today = localDate(realNow, TZ);
  const stampOf = (date: string, time = "10:00") => `${date}T${time}:00.000-03:00`;
  const created = new Date(stampOf(addDays(today, -40), "09:00")).toISOString();

  const projectId = newId();
  const owner: Actor = { userId: newId(), name: "Juan Hernández", role: "propietario" };
  const engineer: Actor = { userId: newId(), name: "Marcelo Ríos", role: "ingeniero" };

  await db.batch([
    db.insert(t.projects).values({ id: projectId, name: "Casa Córdoba", timezone: TZ, currency: "ARS", createdAt: created }),
    db.insert(t.users).values({ id: owner.userId, projectId, name: owner.name, role: owner.role, email: "juan@casacordoba.local", canLogin: true, createdAt: created }),
    db.insert(t.users).values({ id: engineer.userId, projectId, name: engineer.name, role: engineer.role, email: "marcelo@casacordoba.local", canLogin: true, createdAt: created }),
    ...UNITS.map((u) => db.insert(t.units).values(u).onConflictDoNothing()),
  ] as unknown as Parameters<AppDb["batch"]>[0]);

  const supplierIds: Record<string, string> = {};
  const materialIds: Record<string, string> = {};
  const catalog: Parameters<AppDb["batch"]>[0][number][] = [];
  for (const s of SUPPLIERS) {
    supplierIds[s.key] = newId();
    catalog.push(
      db.insert(t.suppliers).values({
        id: supplierIds[s.key]!,
        projectId,
        name: s.name,
        normalizedName: normalizeText(s.name),
        category: s.category,
        contactName: s.contactName,
        phone: s.phone,
        aliases: JSON.stringify(s.aliases),
        createdAt: created,
        updatedAt: created,
      }),
    );
  }
  for (const m of MATERIALS) {
    materialIds[m.key] = newId();
    catalog.push(
      db.insert(t.materials).values({
        id: materialIds[m.key]!,
        projectId,
        name: m.name,
        normalizedName: normalizeText(m.name),
        shortName: m.short,
        spec: m.spec,
        baseUnit: m.unit,
        category: m.category,
        usualSupplierId: supplierIds[m.supplier]!,
        active: true,
        createdAt: created,
        updatedAt: created,
      }),
    );
    for (const alias of m.aliases) {
      catalog.push(db.insert(t.materialAliases).values({ id: newId(), projectId, materialId: materialIds[m.key]!, alias, normalizedAlias: normalizeText(alias), source: "seed", createdAt: created }));
    }
  }
  for (const c of CONVERSIONS) {
    catalog.push(db.insert(t.unitConversions).values({ id: newId(), materialId: materialIds[c.material]!, fromUnit: c.from, toUnit: c.to, factorNum: c.num, factorDen: c.den }));
  }
  await db.batch(catalog as unknown as Parameters<AppDb["batch"]>[0]);
  if (options.empty) return { projectId, today };

  // ---------------------------------------------------------------- history
  const at = (offset: number, time: string) => new Date(stampOf(addDays(today, offset), time));
  const ctx = (actor: Actor, when: Date, source: CommandContext["source"] = "seed"): CommandContext => ({ db, projectId, actor, source, now: () => when });
  const day = (offset: number) => addDays(today, offset);
  const q = (n: number) => toMilli(n)!;
  const pesos = (n: number) => Math.round(n * 100);
  const doc = async (when: Date, fileName: string, lines: string[]) => {
    const row = await storeDocument(
      { db, storage, projectId, userId: owner.userId, now: () => when },
      { fileName, mimeType: "application/pdf", data: simplePdf([{ text: lines[0]!, size: 15, bold: true }, ...lines.slice(1).map((text) => ({ text }))]) },
    );
    return row.id;
  };
  const fmtDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const S = supplierIds;
  const M = materialIds;

  // Pedido 31 · Ladrillera · delivered and fully paid (cash).
  const o31 = await commands.createOrder(ctx(owner, at(-27, "09:05")), {
    supplier: { id: S.ladrillera! },
    reference: "31",
    date: day(-27),
    orderedByName: "Juan Hernández",
    purchaseMode: "contado",
    items: [{ material: { id: M.ladrillo! }, quantityMilli: q(3000), unit: "unidad", unitPriceMinor: pesos(300) }],
    documentIds: [await doc(at(-27, "09:04"), "pedido_31_ladrillera.pdf", ["NOTA DE PEDIDO N° 31", "Ladrillera El Algarrobo", `Fecha: ${fmtDate(day(-27))}`, "3000 u Ladrillo cerámico 18x18x33 $300", "Total: $900.000"])],
  });
  await commands.registerDelivery(ctx(owner, at(-24, "08:30")), { orderId: o31.orderId, date: day(-24), reference: "0001-2104", items: [{ orderItemId: await firstItem(db, o31.orderId, 0), quantityMilli: q(3000) }] });
  await commands.createPayment(ctx(owner, at(-22, "12:00")), { supplierId: S.ladrillera!, date: day(-22), amountMinor: pesos(900000), method: "efectivo", allocations: [{ orderId: o31.orderId, amountMinor: pesos(900000) }] });

  // Pedido 352 · Hierros · delivered, partially paid.
  const o352 = await commands.createOrder(ctx(engineer, at(-20, "10:00")), {
    supplier: { id: S.hierros! },
    reference: "352",
    date: day(-20),
    orderedByName: "Marcelo Ríos",
    purchaseMode: "cuenta_corriente",
    items: [
      { material: { id: M.a12! }, quantityMilli: q(60), unit: "barra", unitPriceMinor: pesos(18000) },
      { material: { id: M.a10! }, quantityMilli: q(20), unit: "barra", unitPriceMinor: pesos(12000) },
      { material: { id: M.a8! }, quantityMilli: q(40), unit: "barra", unitPriceMinor: pesos(7000) },
      { material: { id: M.malla! }, quantityMilli: q(15), unit: "malla", unitPriceMinor: pesos(7844) },
    ],
    documentIds: [await doc(at(-20, "09:58"), "comprobante_pedido_352.pdf", ["PEDIDO N° 352", "Hierros Córdoba", `Fecha: ${fmtDate(day(-20))}`, "60 barras Acero Ø12 $18.000", "20 barras Acero Ø10 $12.000", "40 barras Acero Ø8 $7.000", "15 mallas Malla sima Ø4,2 $7.844", "Total: $1.717.660"])],
  });
  await commands.registerDelivery(ctx(engineer, at(-14, "16:30")), {
    orderId: o352.orderId,
    date: day(-14),
    reference: "0012-4102",
    items: await Promise.all([0, 1, 2, 3].map(async (i) => ({ orderItemId: await firstItem(db, o352.orderId, i), quantityMilli: q([60, 20, 40, 15][i]!) }))),
    documentIds: [await doc(at(-14, "16:29"), "remito_0352.pdf", ["REMITO N° 0012-4102", "Hierros Córdoba", "Pedido 352", "60 barras Acero Ø12", "20 barras Acero Ø10", "40 barras Acero Ø8", "15 mallas Malla sima"])],
  });
  await commands.createPayment(ctx(owner, at(-12, "11:00")), {
    supplierId: S.hierros!,
    date: day(-12),
    amountMinor: pesos(600000),
    method: "transferencia",
    allocations: [{ orderId: o352.orderId, amountMinor: pesos(600000) }],
    documentIds: [await doc(at(-12, "10:59"), "transferencia_352.pdf", ["Comprobante de transferencia", "Destinatario: Hierros Córdoba", "Importe: $600.000", "Concepto: pago a cuenta pedido 352"])],
  });

  // Pedido 7781 · Hormigonera · delivered and paid.
  const o7781 = await commands.createOrder(ctx(engineer, at(-15, "09:20")), {
    supplier: { id: S.hormigonera! },
    reference: "7781",
    date: day(-15),
    orderedByName: "Marcelo Ríos",
    purchaseMode: "contado",
    items: [{ material: { id: M.hormigon! }, quantityMilli: q(18), unit: "m3", unitPriceMinor: pesos(241500) }],
    documentIds: [await doc(at(-15, "09:19"), "orden_7781.pdf", ["ORDEN N° 7781", "Hormigonera Sierras", "18 m3 Hormigón H21 $241.500", "Total: $4.347.000"])],
  });
  await commands.registerDelivery(ctx(engineer, at(-14, "08:10")), { orderId: o7781.orderId, date: day(-14), reference: "R-7781", items: [{ orderItemId: await firstItem(db, o7781.orderId, 0), quantityMilli: q(18) }] });
  await commands.createPayment(ctx(owner, at(-14, "08:40")), { supplierId: S.hormigonera!, date: day(-14), amountMinor: pesos(4347000), method: "transferencia", allocations: [{ orderId: o7781.orderId, amountMinor: pesos(4347000) }] });

  // Pedido 0027 · Corralón · delivered and paid.
  const o27 = await commands.createOrder(ctx(owner, at(-10, "09:20")), {
    supplier: { id: S.corralon! },
    reference: "0027",
    date: day(-10),
    orderedByName: "Juan Hernández",
    purchaseMode: "contado",
    items: [
      { material: { id: M.cemento! }, quantityMilli: q(40), unit: "bolsa", unitPriceMinor: pesos(39750) },
      { material: { id: M.cal! }, quantityMilli: q(30), unit: "bolsa", unitPriceMinor: pesos(9350) },
      { material: { id: M.arena! }, quantityMilli: q(6), unit: "m3", unitPriceMinor: pesos(45000) },
    ],
    documentIds: [await doc(at(-10, "09:19"), "presupuesto_0027.pdf", ["PRESUPUESTO N° 0027", "Corralón San Martín", "40 bolsas Cemento portland 50 kg $39.750", "30 bolsas Cal hidráulica $9.350", "6 m3 Arena gruesa $45.000", "Total: $2.140.500"])],
  });
  await commands.registerDelivery(ctx(owner, at(-8, "10:00")), {
    orderId: o27.orderId,
    date: day(-8),
    reference: "0004-1180",
    items: await Promise.all([0, 1, 2].map(async (i) => ({ orderItemId: await firstItem(db, o27.orderId, i), quantityMilli: q([40, 30, 6][i]!) }))),
  });
  await commands.createPayment(ctx(owner, at(-7, "13:15")), { supplierId: S.corralon!, date: day(-7), amountMinor: pesos(2140500), method: "transferencia", allocations: [{ orderId: o27.orderId, amountMinor: pesos(2140500) }] });

  // Pedido 381 · Hierros · partial delivery (5 Ø10 pending), partial payment.
  const o381 = await commands.createOrder(ctx(engineer, at(-12, "11:00")), {
    supplier: { id: S.hierros! },
    reference: "381",
    date: day(-12),
    orderedByName: "Marcelo Ríos",
    purchaseMode: "cuenta_corriente",
    items: [
      { material: { id: M.a12! }, quantityMilli: q(20), unit: "barra", unitPriceMinor: pesos(38420) },
      { material: { id: M.a10! }, quantityMilli: q(30), unit: "barra", unitPriceMinor: pesos(23798) },
    ],
    notes: "Las barras Ø10 faltantes llegan con el próximo envío, según Marcelo.",
    documentIds: [await doc(at(-12, "10:59"), "comprobante_pedido_381.pdf", ["PEDIDO N° 381", "Hierros Córdoba", "20 barras Acero Ø12 $38.420", "30 barras Acero Ø10 $23.798", "Total: $1.482.340"])],
  });
  await commands.registerDelivery(ctx(engineer, at(-8, "15:20")), {
    orderId: o381.orderId,
    date: day(-8),
    reference: "0012-4471",
    items: [
      { orderItemId: await firstItem(db, o381.orderId, 0), quantityMilli: q(20) },
      { orderItemId: await firstItem(db, o381.orderId, 1), quantityMilli: q(15) },
    ],
    documentIds: [await doc(at(-8, "15:19"), "remito_4471.pdf", ["REMITO N° 0012-4471", "Hierros Córdoba", "Pedido 381", "20 barras Acero Ø12", "15 barras Acero Ø10"])],
  });
  await commands.createPayment(ctx(owner, at(-6, "10:30")), {
    supplierId: S.hierros!,
    date: day(-6),
    amountMinor: pesos(600000),
    method: "transferencia",
    allocations: [{ orderId: o381.orderId, amountMinor: pesos(600000) }],
    documentIds: [await doc(at(-6, "10:29"), "transferencia_381.pdf", ["Comprobante de transferencia", "Destinatario: Hierros Córdoba", "Importe: $600.000", "Concepto: pedido 381"])],
  });
  await commands.registerDelivery(ctx(engineer, at(-4, "16:05")), {
    orderId: o381.orderId,
    date: day(-4),
    reference: "0012-4520",
    items: [{ orderItemId: await firstItem(db, o381.orderId, 1), quantityMilli: q(10) }],
    documentIds: [await doc(at(-4, "16:04"), "remito_4520.pdf", ["REMITO N° 0012-4520", "Hierros Córdoba", "Pedido 381", "10 barras Acero Ø10"])],
  });

  // Pedido A-1043 · Sanitarios · no supporting document, nothing delivered.
  await commands.createOrder(ctx(engineer, at(-6, "12:10")), {
    supplier: { id: S.sanitarios! },
    reference: "A-1043",
    date: day(-6),
    orderedByName: "Marcelo Ríos",
    purchaseMode: "cuenta_corriente",
    items: [
      { material: { id: M.cano! }, quantityMilli: q(48), unit: "unidad", unitPriceMinor: pesos(11900) },
      { material: { id: M.codo! }, quantityMilli: q(24), unit: "unidad", unitPriceMinor: pesos(1712.5) },
    ],
  });

  // Pedido 38 · Hierros · ordered, nothing delivered or paid yet (used by the delivery/payment scenarios).
  await commands.createOrder(ctx(engineer, at(-5, "09:40")), {
    supplier: { id: S.hierros! },
    reference: "38",
    date: day(-5),
    orderedByName: "Marcelo Ríos",
    purchaseMode: "cuenta_corriente",
    items: [
      { material: { id: M.a12! }, quantityMilli: q(20), unit: "barra", unitPriceMinor: pesos(38420) },
      { material: { id: M.a10! }, quantityMilli: q(30), unit: "barra", unitPriceMinor: pesos(23798) },
    ],
    documentIds: [await doc(at(-5, "09:39"), "comprobante_pedido_38.pdf", ["PEDIDO N° 38", "Hierros Córdoba", "20 barras Acero Ø12 $38.420", "30 barras Acero Ø10 $23.798", "Total: $1.482.340"])],
  });

  // Pedido 41 · Ladrillera · delivered in full, not paid yet.
  const o41 = await commands.createOrder(ctx(engineer, at(-3, "08:50")), {
    supplier: { id: S.ladrillera! },
    reference: "41",
    date: day(-3),
    orderedByName: "Marcelo Ríos",
    purchaseMode: "cuenta_corriente",
    items: [{ material: { id: M.ladrillo! }, quantityMilli: q(3000), unit: "unidad", unitPriceMinor: pesos(320) }],
    documentIds: [await doc(at(-3, "08:49"), "pedido_41_ladrillera.pdf", ["NOTA DE PEDIDO N° 41", "Ladrillera El Algarrobo", "3000 u Ladrillo cerámico 18x18x33 $320", "Total: $960.000"])],
  });
  await commands.registerDelivery(ctx(engineer, at(-1, "09:30")), {
    orderId: o41.orderId,
    date: day(-1),
    reference: "0001-2231",
    items: [{ orderItemId: await firstItem(db, o41.orderId, 0), quantityMilli: q(3000) }],
    documentIds: [await doc(at(-1, "09:29"), "remito_2231.pdf", ["REMITO N° 0001-2231", "Ladrillera El Algarrobo", "Pedido 41", "3000 u Ladrillo cerámico 18x18x33"])],
  });

  // Pedido 0035 · Corralón · price unknown until delivery.
  await commands.createOrder(ctx(owner, at(-1, "11:05")), {
    supplier: { id: S.corralon! },
    reference: "0035",
    date: day(-1),
    orderedByName: "Marcelo Ríos",
    purchaseMode: "cuenta_corriente",
    items: [{ material: { id: M.cemento! }, quantityMilli: q(20), unit: "bolsa", unitPriceMinor: null }],
    notes: "Pedido por WhatsApp. El corralón confirma el precio al entregar.",
    documentIds: [await doc(at(-1, "11:04"), "whatsapp_corralon_0035.pdf", ["Pedido por WhatsApp · Corralón San Martín", "Pedido 0035", "20 bolsas de cemento", "Precio a confirmar en la entrega"])],
  });

  // Payment to Hierros Córdoba's current account, not allocated to any order.
  await commands.createPayment(ctx(owner, at(-1, "18:40")), {
    supplierId: S.hierros!,
    date: day(-1),
    amountMinor: pesos(500000),
    method: "transferencia",
    allocations: [],
    documentIds: [await doc(at(-1, "18:39"), "comprobante_pago_cc.pdf", ["Comprobante de transferencia", "Destinatario: Hierros Córdoba", "Importe: $500.000", "Concepto: a cuenta"])],
  });

  // Computation: loaded two days ago, then Ø10 revised (history kept).
  await commands.setComputationItems(
    ctx(engineer, at(-2, "17:30")),
    [
      { material: { id: M.a12! }, expectedQuantityMilli: q(90), unit: "barra" },
      { material: { id: M.a10! }, expectedQuantityMilli: q(75), unit: "barra" },
      { material: { id: M.a8! }, expectedQuantityMilli: q(120), unit: "barra" },
      { material: { id: M.malla! }, expectedQuantityMilli: q(30), unit: "malla" },
      { material: { id: M.cemento! }, expectedQuantityMilli: q(300), unit: "bolsa", wasteBasisPoints: 500 },
      { material: { id: M.cal! }, expectedQuantityMilli: q(200), unit: "bolsa" },
      { material: { id: M.arena! }, expectedQuantityMilli: q(40), unit: "m3" },
      { material: { id: M.ladrillo! }, expectedQuantityMilli: q(9000), unit: "unidad" },
      { material: { id: M.hormigon! }, expectedQuantityMilli: q(60), unit: "m3" },
      { material: { id: M.cano! }, expectedQuantityMilli: q(48), unit: "unidad" },
    ],
    { importLabel: "carga inicial" },
  );
  await commands.setComputationItems(ctx(engineer, at(-2, "17:45")), [{ material: { id: M.a10! }, expectedQuantityMilli: q(85), unit: "barra" }], {
    reason: "Se sumaron las vigas del quincho.",
  });

  // One past conversation, for display only (the records above are the source of truth).
  const conversationId = newId();
  const cAt = at(-1, "18:38").toISOString();
  await db.batch([
    db.insert(t.conversations).values({ id: conversationId, projectId, title: "Pago a Hierros Córdoba", createdBy: owner.userId, createdAt: cAt, updatedAt: at(-1, "18:41").toISOString() }),
    db.insert(t.chatMessages).values({ id: newId(), conversationId, role: "user", text: "Pagamos $500.000 de la cuenta corriente de Hierros Córdoba.", authorUserId: owner.userId, createdAt: cAt }),
    db.insert(t.chatMessages).values({
      id: newId(),
      conversationId,
      role: "assistant",
      blocks: JSON.stringify([
        { type: "text", text: "Listo, registré el pago como pago a cuenta corriente, sin imputar a un pedido. Ya reduce el saldo con Hierros Córdoba." },
        { type: "saved_record", title: "Pago registrado · Hierros Córdoba", subtitle: `$500.000 · Transferencia · ${fmtDate(day(-1))}`, tag: "pago_sin_imputar", link: { to: "/proveedores/$supplierId", params: { supplierId: S.hierros! } } },
      ]),
      createdAt: at(-1, "18:41").toISOString(),
    }),
  ] as unknown as Parameters<AppDb["batch"]>[0]);

  return { projectId, today };
}

async function firstItem(db: AppDb, orderId: string, position: number): Promise<string> {
  const items = await db.select().from(t.orderItems);
  const item = items.filter((i) => i.orderId === orderId).sort((a, b) => a.position - b.position)[position];
  if (!item) throw new Error(`Seed: ítem ${position} del pedido ${orderId} no encontrado`);
  return item.id;
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import("./config");
  const { migrateDatabase, openDatabase } = await import("./db/node");
  const { LocalFileStorage } = await import("./storage/local");
  const config = loadConfig();
  const empty = process.argv.includes("--empty");
  if (config.databaseUrl.startsWith("file:")) {
    const path = resolve(config.databaseUrl.slice(5));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
  }
  rmSync(resolve(config.documentsDir), { recursive: true, force: true });
  const { db, client } = await openDatabase(config.databaseUrl);
  await migrateDatabase(db);
  const result = await seedDatabase(db, new LocalFileStorage(config.documentsDir), { empty });
  client.close();
  console.log(`${empty ? "Proyecto vacío" : "Datos de demostración"} cargados (hoy: ${result.today}) en ${config.databaseUrl}`);
}
