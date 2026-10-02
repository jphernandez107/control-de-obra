import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Relational model for Casa Córdoba. Written for SQLite so the same schema
// and migrations run on local libsql files and on Cloudflare D1.
//
// Conventions
// - ids: application-generated UUID strings (crypto.randomUUID works in Node and Workers).
// - money: integer minor units (`*_minor`, centavos) + ISO currency code. Never floats.
// - quantities: integer thousandths of the unit (`*_milli`), so 6,5 m³ = 6500.
// - dates: `YYYY-MM-DD` text; timestamps: ISO-8601 UTC text.
// - records referenced by history are never deleted: they are voided (`voided_at`).
//   Derivations ignore voided rows; the audit log keeps what happened.

const id = () => text("id").primaryKey();
const createdAt = () => text("created_at").notNull();
const updatedAt = () => text("updated_at").notNull();

export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Argentina/Cordoba"),
  currency: text("currency").notNull().default("ARS"),
  createdAt: createdAt(),
});

/** People who act in the app or are named in records (owner, engineer…). */
export const users = sqliteTable(
  "users",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    role: text("role").notNull(), // propietario | ingeniero | otro
    email: text("email"),
    /** Whether this person can sign in (vs. only being referenced, e.g. "pedido por"). */
    canLogin: integer("can_login", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const units = sqliteTable("units", {
  code: text("code").primaryKey(), // barra, kg, m, m2, m3, bolsa, unidad, malla, l
  /** Label shown next to quantities in the UI (`barras`, `m³`, `u`). */
  label: text("label").notNull(),
  singular: text("singular").notNull(),
  plural: text("plural").notNull(),
});

export const suppliers = sqliteTable(
  "suppliers",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    category: text("category").notNull().default("Varios"),
    contactName: text("contact_name"),
    phone: text("phone"),
    /** JSON array of alternative names the assistant may hear ("la ladrillera"). */
    aliases: text("aliases").notNull().default("[]"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("suppliers_project_name_uq").on(t.projectId, t.normalizedName)],
);

export const materials = sqliteTable(
  "materials",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    /** Compact label used in sentences ("Ø12", "cemento"). */
    shortName: text("short_name").notNull(),
    spec: text("spec"),
    baseUnit: text("base_unit").notNull().references(() => units.code),
    category: text("category").notNull().default("Varios"),
    usualSupplierId: text("usual_supplier_id").references(() => suppliers.id),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("materials_project_name_uq").on(t.projectId, t.normalizedName)],
);

/** Alternative spellings that map to a catalog material ("hierro del 12" → Acero Ø12). */
export const materialAliases = sqliteTable(
  "material_aliases",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    materialId: text("material_id").notNull().references(() => materials.id),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    source: text("source").notNull(), // seed | confirmed | manual
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("material_aliases_uq").on(t.projectId, t.normalizedAlias)],
);

/**
 * Explicit unit conversions (e.g. 1 barra Ø12 = 12 m). Factors are rational
 * (numerator/denominator) so no floating point enters quantity math.
 * `material_id` null = generic conversion valid for every material.
 */
export const unitConversions = sqliteTable(
  "unit_conversions",
  {
    id: id(),
    materialId: text("material_id").references(() => materials.id),
    fromUnit: text("from_unit").notNull().references(() => units.code),
    toUnit: text("to_unit").notNull().references(() => units.code),
    factorNum: integer("factor_num").notNull(),
    factorDen: integer("factor_den").notNull().default(1),
  },
  (t) => [check("unit_conversions_factor_ck", sql`${t.factorNum} > 0 AND ${t.factorDen} > 0`)],
);

export const documents = sqliteTable(
  "documents",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    kind: text("kind").notNull(), // order_proof | delivery_proof | payment_proof | computation | other
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Opaque key understood by the DocumentStorage adapter (local path today, R2 key later). */
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256"),
    supplierId: text("supplier_id").references(() => suppliers.id),
    documentDate: text("document_date"),
    uploadedBy: text("uploaded_by").references(() => users.id),
    uploadedAt: text("uploaded_at").notNull(),
  },
  (t) => [
    check("documents_kind_ck", sql`${t.kind} IN ('order_proof','delivery_proof','payment_proof','computation','other')`),
    check("documents_size_ck", sql`${t.sizeBytes} >= 0`),
  ],
);

export const orders = sqliteTable(
  "orders",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    supplierId: text("supplier_id").notNull().references(() => suppliers.id),
    /** Sequential number inside the project, used when the supplier gave none. */
    internalNumber: integer("internal_number").notNull(),
    /** Supplier/external reference ("381", "A-1043"). Optional. */
    reference: text("reference"),
    normalizedReference: text("normalized_reference"),
    orderDate: text("order_date").notNull(),
    orderedByName: text("ordered_by_name"),
    orderedByUserId: text("ordered_by_user_id").references(() => users.id),
    purchaseMode: text("purchase_mode").notNull().default("cuenta_corriente"),
    currency: text("currency").notNull().default("ARS"),
    /** Total stated by the supplier when line prices are unknown. Overrides the line sum. */
    statedTotalMinor: integer("stated_total_minor"),
    notes: text("notes"),
    source: text("source").notNull(), // assistant | manual | seed
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    voidedAt: text("voided_at"),
    voidedBy: text("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("orders_internal_number_uq").on(t.projectId, t.internalNumber),
    index("orders_supplier_idx").on(t.supplierId),
    index("orders_reference_idx").on(t.projectId, t.normalizedReference),
    check("orders_mode_ck", sql`${t.purchaseMode} IN ('cuenta_corriente','contado')`),
    check("orders_total_ck", sql`${t.statedTotalMinor} IS NULL OR ${t.statedTotalMinor} >= 0`),
  ],
);

export const orderItems = sqliteTable(
  "order_items",
  {
    id: id(),
    orderId: text("order_id").notNull().references(() => orders.id),
    materialId: text("material_id").notNull().references(() => materials.id),
    /** Wording as it appeared in the order ("Barra Ø12 x 12 m"). */
    description: text("description").notNull(),
    quantityMilli: integer("quantity_milli").notNull(),
    unit: text("unit").notNull().references(() => units.code),
    unitPriceMinor: integer("unit_price_minor"),
    lineTotalMinor: integer("line_total_minor"),
    position: integer("position").notNull(),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    index("order_items_material_idx").on(t.materialId),
    check("order_items_qty_ck", sql`${t.quantityMilli} > 0`),
    check("order_items_price_ck", sql`(${t.unitPriceMinor} IS NULL OR ${t.unitPriceMinor} >= 0) AND (${t.lineTotalMinor} IS NULL OR ${t.lineTotalMinor} >= 0)`),
  ],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    supplierId: text("supplier_id").notNull().references(() => suppliers.id),
    /** Linked order when known. */
    orderId: text("order_id").references(() => orders.id),
    deliveryDate: text("delivery_date").notNull(),
    /** Remito / delivery note number. */
    reference: text("reference"),
    notes: text("notes"),
    source: text("source").notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    voidedAt: text("voided_at"),
    voidedBy: text("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [index("deliveries_order_idx").on(t.orderId), index("deliveries_supplier_idx").on(t.supplierId)],
);

export const deliveryItems = sqliteTable(
  "delivery_items",
  {
    id: id(),
    deliveryId: text("delivery_id").notNull().references(() => deliveries.id),
    orderItemId: text("order_item_id").references(() => orderItems.id),
    materialId: text("material_id").notNull().references(() => materials.id),
    quantityMilli: integer("quantity_milli").notNull(),
    unit: text("unit").notNull().references(() => units.code),
  },
  (t) => [
    index("delivery_items_delivery_idx").on(t.deliveryId),
    index("delivery_items_order_item_idx").on(t.orderItemId),
    check("delivery_items_qty_ck", sql`${t.quantityMilli} > 0`),
  ],
);

export const payments = sqliteTable(
  "payments",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    supplierId: text("supplier_id").notNull().references(() => suppliers.id),
    paymentDate: text("payment_date").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("ARS"),
    method: text("method"), // transferencia | efectivo | cheque | otro
    reference: text("reference"),
    notes: text("notes"),
    source: text("source").notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    voidedAt: text("voided_at"),
    voidedBy: text("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("payments_supplier_idx").on(t.supplierId),
    check("payments_amount_ck", sql`${t.amountMinor} > 0`),
    check("payments_method_ck", sql`${t.method} IS NULL OR ${t.method} IN ('transferencia','efectivo','cheque','otro')`),
  ],
);

/**
 * Portion of a payment applied to one order. A payment can have zero
 * allocations (paid to the supplier's current account), one, or several.
 * Allocations are never edited in place: a change voids the old row.
 */
export const paymentAllocations = sqliteTable(
  "payment_allocations",
  {
    id: id(),
    paymentId: text("payment_id").notNull().references(() => payments.id),
    orderId: text("order_id").notNull().references(() => orders.id),
    amountMinor: integer("amount_minor").notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    voidedAt: text("voided_at"),
    voidedBy: text("voided_by").references(() => users.id),
  },
  (t) => [
    index("payment_allocations_payment_idx").on(t.paymentId),
    index("payment_allocations_order_idx").on(t.orderId),
    check("payment_allocations_amount_ck", sql`${t.amountMinor} > 0`),
  ],
);

/** Evidence attached to a business record. Exactly one target per row. */
export const documentLinks = sqliteTable(
  "document_links",
  {
    id: id(),
    documentId: text("document_id").notNull().references(() => documents.id),
    orderId: text("order_id").references(() => orders.id),
    deliveryId: text("delivery_id").references(() => deliveries.id),
    paymentId: text("payment_id").references(() => payments.id),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    voidedAt: text("voided_at"),
  },
  (t) => [
    index("document_links_document_idx").on(t.documentId),
    index("document_links_order_idx").on(t.orderId),
    check(
      "document_links_one_target_ck",
      sql`(${t.orderId} IS NOT NULL) + (${t.deliveryId} IS NOT NULL) + (${t.paymentId} IS NOT NULL) = 1`,
    ),
  ],
);

/** Expected material quantities. One active baseline per project; `version` grows on each change. */
export const computations = sqliteTable("computations", {
  id: id(),
  projectId: text("project_id").notNull().references(() => projects.id),
  version: integer("version").notNull().default(1),
  sourceDocumentId: text("source_document_id").references(() => documents.id),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("computations_project_uq").on(t.projectId)]);

export const computationItems = sqliteTable(
  "computation_items",
  {
    id: id(),
    computationId: text("computation_id").notNull().references(() => computations.id),
    materialId: text("material_id").notNull().references(() => materials.id),
    expectedQuantityMilli: integer("expected_quantity_milli").notNull(),
    unit: text("unit").notNull().references(() => units.code),
    stage: text("stage"),
    /** Waste allowance in basis points (500 = 5 %). */
    wasteBasisPoints: integer("waste_basis_points").notNull().default(0),
    notes: text("notes"),
    /** Ordered quantity at the moment the user marked an over/near-computation alert as reviewed. */
    reviewedOrderedMilli: integer("reviewed_ordered_milli"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("computation_items_material_uq").on(t.computationId, t.materialId),
    check("computation_items_qty_ck", sql`${t.expectedQuantityMilli} > 0`),
    check("computation_items_waste_ck", sql`${t.wasteBasisPoints} >= 0`),
  ],
);

/** Append-only history of every computation value change. The current value lives in computation_items. */
export const computationRevisions = sqliteTable(
  "computation_revisions",
  {
    id: id(),
    computationId: text("computation_id").notNull().references(() => computations.id),
    materialId: text("material_id").notNull().references(() => materials.id),
    computationVersion: integer("computation_version").notNull(),
    changeType: text("change_type").notNull(), // created | updated
    previousQuantityMilli: integer("previous_quantity_milli"),
    newQuantityMilli: integer("new_quantity_milli").notNull(),
    previousUnit: text("previous_unit"),
    newUnit: text("new_unit").notNull(),
    reason: text("reason"),
    source: text("source").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("computation_revisions_material_idx").on(t.materialId)],
);

export const conversations = sqliteTable("conversations", {
  id: id(),
  projectId: text("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: id(),
    conversationId: text("conversation_id").notNull().references(() => conversations.id),
    role: text("role").notNull(), // user | assistant
    text: text("text"),
    /** Rendered assistant blocks (JSON). Display history only — never the source of truth. */
    blocks: text("blocks"),
    authorUserId: text("author_user_id").references(() => users.id),
    /** JSON { orderIds, supplierIds, materialIds }: what this reply was about, for follow-up questions. Ids only, never figures. */
    contextRefs: text("context_refs"),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const messageAttachments = sqliteTable("message_attachments", {
  id: id(),
  messageId: text("message_id").notNull().references(() => chatMessages.id),
  documentId: text("document_id").notNull().references(() => documents.id),
});

/**
 * Pending AI action: a structured write proposal produced from a message or
 * document. Nothing reaches the domain tables until a user confirms it.
 * (Table name kept from the first schema; the code calls it PendingAIAction.)
 */
export const aiInterpretations = sqliteTable(
  "ai_interpretations",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    conversationId: text("conversation_id").references(() => conversations.id),
    messageId: text("message_id").references(() => chatMessages.id),
    documentId: text("document_id").references(() => documents.id),
    provider: text("provider").notNull(),
    model: text("model"),
    intent: text("intent").notNull(),
    confidence: integer("confidence_pct"),
    /** Validated provider output (application schema). */
    providerOutput: text("provider_output"),
    /** Proposal shown to the user (application-owned). */
    proposal: text("proposal").notNull(),
    /** Proposal as confirmed, after user edits. */
    confirmedProposal: text("confirmed_proposal"),
    status: text("status").notNull(), // pending | confirmed | cancelled | undone
    /** Server validation of the current proposal: ready | needs_review | blocked. */
    validationState: text("validation_state"),
    /** JSON string[]: matching warnings shown to the user (Spanish). */
    warnings: text("warnings"),
    /** JSON string[]: fields that still need the user (supplier, material, order, amount…). */
    unresolvedFields: text("unresolved_fields"),
    resultEntityType: text("result_entity_type"),
    resultEntityId: text("result_entity_id"),
    result: text("result"),
    createdAt: createdAt(),
    resolvedAt: text("resolved_at"),
    resolvedBy: text("resolved_by").references(() => users.id),
  },
  (t) => [index("ai_interpretations_status_idx").on(t.projectId, t.status)],
);

/** Append-only log of confirmed domain mutations. Corrections add rows; nothing is rewritten. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id),
    at: text("at").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id),
    source: text("source").notNull(), // assistant | manual | system | seed
    action: text("action").notNull(), // order.created, delivery.created, payment.allocated…
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    summary: text("summary").notNull(),
    shortSummary: text("short_summary"),
    /** JSON array of { label, before, after }. */
    changes: text("changes"),
    reason: text("reason"),
    /** JSON: status tags, ids, interpretation id, etc. */
    metadata: text("metadata"),
    supplierId: text("supplier_id").references(() => suppliers.id),
    orderId: text("order_id").references(() => orders.id),
    aiInterpretationId: text("ai_interpretation_id").references(() => aiInterpretations.id),
  },
  (t) => [index("audit_log_project_at_idx").on(t.projectId, t.at), index("audit_log_order_idx").on(t.orderId)],
);
