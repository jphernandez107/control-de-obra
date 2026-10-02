import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AssistantBlock, Attachment, ChatMessage, ConfirmResponse, ConfirmResult, Conversation, Interpretation } from "../../src/domain/assistant";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { answerQuery } from "../ai/answers";
import { AINotConfiguredError } from "../ai/disabled";
import { AIMalformedResponseError, AIUnavailableError, type AIContext, type AIProvider } from "../ai/provider";
import { proposeAllocation, proposeDelivery, proposeOrder, proposePayment, resolvePaymentChoice, type ProposalResult } from "../ai/proposals";
import { confirmInterpretation, reviseInterpretation } from "../ai/review";
import { ExtractionSchema, type Extraction } from "../ai/schemas";
import type { Ledger } from "../domain/derive";
import { DomainError } from "../domain/errors";
import { formatNumber } from "../../src/domain/format";
import { fromMilli } from "../domain/quantity";
import { localDate, localDateTime } from "../domain/time";
import type { DocumentStorage } from "../storage/storage";
import { voidAllocations, voidRecord } from "./commands";
import { newId, type Actor, type CommandContext } from "./context";
import { AI_READABLE, readDocumentBytes } from "./documents";
import { ledgerFor } from "./queries";

// Conversation layer of the assistant. Chat history is stored for display
// only; every answer and proposal is computed from the domain tables, and
// writes happen exclusively through confirm() → validated domain commands.

export interface AssistantDeps {
  db: AppDb;
  projectId: string;
  provider: AIProvider;
  storage: DocumentStorage;
  now: () => Date;
}

type DocumentRow = typeof t.documents.$inferSelect;

const CONFIRM_LABEL: Record<Interpretation["kind"], string> = { order: "Confirmar pedido", delivery: "Confirmar entrega", payment: "Confirmar pago" };
const FOLLOW_UP: Record<Interpretation["kind"], string> = {
  order: "Listo. Cuando llegue el material, escríbeme algo como «llegaron las 20 barras del 12» o envíame la foto del remito.",
  delivery: "Listo, la entrega quedó registrada. El estado de pago no cambió.",
  payment: "Listo, el pago quedó registrado y el saldo del proveedor ya está actualizado.",
};

function sizeLabel(bytes: number): string {
  const kb = bytes / 1024;
  return kb > 1024 ? `${(kb / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(kb))} KB`;
}

export function toAttachment(doc: DocumentRow): Attachment {
  return {
    id: doc.id,
    documentId: doc.id,
    fileName: doc.fileName,
    format: doc.mimeType === "application/pdf" ? "pdf" : "image",
    sizeLabel: sizeLabel(doc.sizeBytes),
    url: `/api/documents/${doc.id}/file`,
    previewUrl: doc.mimeType.startsWith("image/") && doc.mimeType !== "image/heic" && doc.mimeType !== "image/heif" ? `/api/documents/${doc.id}/file` : undefined,
  };
}

function aiErrorBlocks(error: unknown): AssistantBlock[] {
  if (error instanceof AINotConfiguredError) {
    return [
      { type: "text", text: `${error.message} No se guardó nada.` },
      { type: "note", text: "Mientras tanto puedes registrar entregas y pagos desde Pedidos o Proveedores, y consultar saldos en Proveedores." },
    ];
  }
  if (error instanceof AIUnavailableError) {
    return [
      { type: "text", text: `El asistente de IA no está disponible en este momento: ${error.message} No se guardó nada.` },
      { type: "note", text: "Mientras tanto puedes registrar entregas y pagos desde Pedidos o Proveedores, y consultar saldos en Proveedores." },
    ];
  }
  if (error instanceof AIMalformedResponseError) {
    return [{ type: "text", text: "No pude interpretar la respuesta del asistente de IA. No se guardó nada; intenta reformular el mensaje o vuelve a enviarlo." }];
  }
  throw error;
}

export class AssistantService {
  constructor(private deps: AssistantDeps) {}

  private get db() {
    return this.deps.db;
  }

  private async ledger(): Promise<Ledger> {
    return ledgerFor({ db: this.db, projectId: this.deps.projectId, now: this.deps.now });
  }

  private commandContext(actor: Actor, source: CommandContext["source"], aiInterpretationId?: string): CommandContext {
    return { db: this.db, projectId: this.deps.projectId, actor, source, aiInterpretationId, now: this.deps.now };
  }

  private stamp(ledger: Ledger, at = this.deps.now()): string {
    return localDateTime(at, ledger.tz);
  }

  // -------------------------------------------------------------- reading

  async conversations(): Promise<Conversation[]> {
    const ledger = await this.ledger();
    const rows = await this.db.select().from(t.conversations).where(eq(t.conversations.projectId, this.deps.projectId)).orderBy(desc(t.conversations.updatedAt)).limit(50);
    const out: Conversation[] = [];
    for (const c of rows) {
      const [last] = await this.db
        .select({ text: t.chatMessages.text, role: t.chatMessages.role })
        .from(t.chatMessages)
        .where(and(eq(t.chatMessages.conversationId, c.id), eq(t.chatMessages.role, "user")))
        .orderBy(desc(t.chatMessages.createdAt))
        .limit(1);
      out.push({ id: c.id, title: c.title, date: localDate(c.updatedAt, ledger.tz), preview: last?.text ?? "Adjunto" });
    }
    return out;
  }

  /** Latest conversation, or an empty thread. */
  async thread(conversationId?: string): Promise<{ today: string; conversationId: string | null; messages: ChatMessage[] }> {
    const ledger = await this.ledger();
    const today = localDate(this.deps.now(), ledger.tz);
    let id = conversationId;
    if (!id) {
      const [latest] = await this.db.select({ id: t.conversations.id }).from(t.conversations).where(eq(t.conversations.projectId, this.deps.projectId)).orderBy(desc(t.conversations.updatedAt)).limit(1);
      id = latest?.id;
    }
    if (!id) return { today, conversationId: null, messages: [] };
    return { today, conversationId: id, messages: await this.messages(id, ledger) };
  }

  private async messages(conversationId: string, ledger: Ledger): Promise<ChatMessage[]> {
    const [conversation] = await this.db.select().from(t.conversations).where(eq(t.conversations.id, conversationId));
    if (!conversation || conversation.projectId !== this.deps.projectId) throw new DomainError("not_found", "Conversación no encontrada");
    const rows = await this.db.select().from(t.chatMessages).where(eq(t.chatMessages.conversationId, conversationId)).orderBy(asc(t.chatMessages.createdAt));
    const attachments = rows.length
      ? await this.db
          .select({ messageId: t.messageAttachments.messageId, doc: t.documents })
          .from(t.messageAttachments)
          .innerJoin(t.documents, eq(t.messageAttachments.documentId, t.documents.id))
          .innerJoin(t.chatMessages, eq(t.messageAttachments.messageId, t.chatMessages.id))
          .where(eq(t.chatMessages.conversationId, conversationId))
      : [];
    const interpretations = await this.db.select().from(t.aiInterpretations).where(eq(t.aiInterpretations.conversationId, conversationId));
    const byId = new Map(interpretations.map((i) => [i.id, i]));
    return rows.map((m) => {
      const blocks = m.blocks ? (JSON.parse(m.blocks) as AssistantBlock[]).map((b) => this.rehydrate(b, byId)) : undefined;
      return {
        id: m.id,
        role: m.role as ChatMessage["role"],
        at: localDateTime(m.createdAt, ledger.tz),
        text: m.text ?? undefined,
        attachments: attachments.filter((a) => a.messageId === m.id).map((a) => toAttachment(a.doc)),
        blocks,
      };
    });
  }

  /** Interpretation blocks show their current lifecycle state from `ai_interpretations`, not the stored snapshot. */
  private rehydrate(block: AssistantBlock, byId: Map<string, typeof t.aiInterpretations.$inferSelect>): AssistantBlock {
    if (block.type !== "interpretation") return block;
    const isResult = block.id.endsWith("-result");
    const row = byId.get(isResult ? block.id.slice(0, -7) : block.id);
    if (!row) return block;
    const result = row.result ? (JSON.parse(row.result) as ConfirmResult) : undefined;
    if (row.status === "pending") return { ...block, state: "pending", interpretation: JSON.parse(row.proposal) as Interpretation };
    if (row.status === "confirmed") return { ...block, state: "confirmed", result, interpretation: JSON.parse(row.confirmedProposal ?? row.proposal) as Interpretation };
    return { ...block, state: "cancelled", result: undefined };
  }

  // -------------------------------------------------------------- writing chat

  private async ensureConversation(actor: Actor, conversationId: string | undefined, title: string): Promise<string> {
    if (conversationId) {
      const [c] = await this.db.select().from(t.conversations).where(eq(t.conversations.id, conversationId));
      if (c && c.projectId === this.deps.projectId) return c.id;
    }
    const id = newId();
    const now = this.deps.now().toISOString();
    await this.db.insert(t.conversations).values({ id, projectId: this.deps.projectId, title: title.slice(0, 80) || "Conversación", createdBy: actor.userId, createdAt: now, updatedAt: now });
    return id;
  }

  async newConversation(actor: Actor): Promise<{ conversationId: string }> {
    return { conversationId: await this.ensureConversation(actor, undefined, "Nueva conversación") };
  }

  private async appendMessage(conversationId: string, message: { role: "user" | "assistant"; text?: string; blocks?: AssistantBlock[]; authorUserId?: string; documentIds?: string[] }, at: Date): Promise<string> {
    const id = newId();
    const createdAt = at.toISOString();
    await this.db.batch([
      this.db.insert(t.chatMessages).values({
        id,
        conversationId,
        role: message.role,
        text: message.text ?? null,
        blocks: message.blocks ? JSON.stringify(message.blocks) : null,
        authorUserId: message.authorUserId ?? null,
        createdAt,
      }),
      ...(message.documentIds ?? []).map((documentId) => this.db.insert(t.messageAttachments).values({ id: newId(), messageId: id, documentId })),
      this.db.update(t.conversations).set({ updatedAt: createdAt }).where(eq(t.conversations.id, conversationId)),
    ] as unknown as Parameters<AppDb["batch"]>[0]);
    return id;
  }

  private aiContext(ledger: Ledger, today: string): AIContext {
    return {
      today,
      suppliers: ledger.s.suppliers.map((s) => s.name),
      materials: ledger.s.materials.filter((m) => m.active).map((m) => ({ name: m.name, unit: ledger.unitLabel(m.baseUnit), aliases: ledger.materialAliases(m.id) })),
      openOrders: ledger.s.orders
        .filter((o) => ledger.orderDeliveryStatus(o) !== "entregado" || ledger.orderPaymentStatus(o) !== "pagado")
        .slice(0, 40)
        .map((o) => ({
          reference: ledger.orderNumber(o),
          supplier: ledger.supplierName(o.supplierId),
          items: ledger
            .items(o.id)
            .map((i) => `${formatNumber(fromMilli(i.quantityMilli))} ${ledger.unitLabel(i.unit)} ${ledger.material(i.materialId)?.name ?? i.description}`)
            .join(", "),
        })),
    };
  }

  /** Interprets a message (and optional document) into answers or proposals. Never writes domain data. */
  private async respond(ledger: Ledger, text: string, documents: DocumentRow[]): Promise<{ blocks: AssistantBlock[]; result?: ProposalResult; extraction?: Extraction; documentId?: string }> {
    const today = localDate(this.deps.now(), ledger.tz);
    const context = this.aiContext(ledger, today);
    const doc = documents[0];
    let extraction: Extraction;
    try {
      if (doc) {
        if (doc.mimeType === "text/csv" || doc.mimeType.includes("spreadsheet")) {
          return { blocks: [{ type: "text", text: "Las planillas de cómputo se cargan desde Materiales y cómputo → Cargar cómputo. Aquí puedo leer comprobantes de pedido, remitos y comprobantes de pago (PDF o foto)." }, { type: "actions", actions: [{ label: "Ir a Materiales", icon: "clipboard-list", link: { to: "/materiales" } }] }] };
        }
        if (!AI_READABLE.has(doc.mimeType)) {
          return { blocks: [{ type: "text", text: `No puedo leer archivos ${doc.mimeType.split("/")[1]?.toUpperCase()}. Envía el comprobante como JPG, PNG o PDF (en el iPhone: Ajustes → Cámara → Formatos → Más compatible).` }] };
        }
        const data = await readDocumentBytes(this.deps.storage, doc);
        extraction = ExtractionSchema.parse(await this.deps.provider.analyzeDocument({ fileName: doc.fileName, mimeType: doc.mimeType, data, text: text || undefined, context }));
      } else {
        extraction = ExtractionSchema.parse(await this.deps.provider.interpret({ text, context }));
      }
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") return { blocks: aiErrorBlocks(new AIMalformedResponseError("schema", error)) };
      return { blocks: aiErrorBlocks(error) };
    }
    const attachment = doc ? toAttachment(doc) : undefined;
    if (doc && extraction.documentType === "unreadable") return { blocks: [{ type: "read_error", fileName: doc.fileName }], extraction, documentId: doc.id };
    if (doc && (extraction.documentType === "other" || extraction.intent === "unknown")) {
      return {
        blocks: [{ type: "text", text: `No reconocí ${doc.fileName} como comprobante de pedido, remito ni comprobante de pago. Cuéntame qué es o escribe los datos y lo registro.` }],
        extraction,
        documentId: doc.id,
      };
    }
    let result: ProposalResult;
    switch (extraction.intent) {
      case "create_order":
        result = proposeOrder(ledger, extraction, today, attachment);
        break;
      case "register_delivery":
      case "complete_order_delivery":
        result = proposeDelivery(ledger, extraction, today, attachment);
        break;
      case "create_payment":
      case "pay_order_balance":
      case "record_supplier_account_payment":
        result = proposePayment(ledger, extraction, today, attachment);
        break;
      case "allocate_payment":
        result = proposeAllocation(ledger, extraction);
        break;
      case "ask_query":
        return { blocks: await answerQuery(ledger, extraction, this.deps.provider, text, today), extraction };
      default:
        return {
          blocks: [
            {
              type: "text",
              text: extraction.note
                ? `${extraction.note} Puedo registrar pedidos, entregas y pagos, o responder sobre saldos y pendientes.`
                : "Puedo registrar pedidos, entregas y pagos, o responder sobre saldos y pendientes. Prueba con algo como «Llegaron las 20 barras del 12» o «¿Cuánto debemos a Hierros Córdoba?».",
            },
          ],
          extraction,
        };
    }
    if (extraction.note && result.proposals.length) result.blocks.splice(1, 0, { type: "note", text: extraction.note });
    return { blocks: result.blocks, result, extraction, documentId: doc?.id };
  }

  private async persistProposals(conversationId: string, messageId: string, result: ProposalResult | undefined, extraction: Extraction | undefined, documentId?: string) {
    if (!result?.proposals.length) return;
    const createdAt = this.deps.now().toISOString();
    await this.db.batch(
      result.proposals.map((p) =>
        this.db.insert(t.aiInterpretations).values({
          id: p.id,
          projectId: this.deps.projectId,
          conversationId,
          messageId,
          documentId: documentId ?? null,
          provider: this.deps.provider.name,
          model: this.deps.provider.model ?? null,
          intent: p.intent,
          confidence: extraction ? Math.round(Math.max(0, Math.min(1, extraction.confidence)) * 100) : null,
          providerOutput: extraction ? JSON.stringify(extraction) : null,
          proposal: JSON.stringify(p.interpretation),
          status: "pending",
          createdAt,
        }),
      ) as unknown as Parameters<AppDb["batch"]>[0],
    );
  }

  async send(actor: Actor, input: { conversationId?: string; text?: string; documentIds?: string[] }): Promise<{ conversationId: string; userMessage: ChatMessage; reply: ChatMessage }> {
    const text = input.text?.trim() ?? "";
    const documentIds = input.documentIds ?? [];
    if (!text && !documentIds.length) throw new DomainError("validation", "Escribe un mensaje o adjunta un comprobante.");
    const documents = documentIds.length ? await this.db.select().from(t.documents).where(inArray(t.documents.id, documentIds.slice(0, 5))) : [];
    if (documents.some((d) => d.projectId !== this.deps.projectId) || documents.length !== documentIds.length) throw new DomainError("not_found", "El documento adjunto no existe.");
    const ledger = await this.ledger();
    const conversationId = await this.ensureConversation(actor, input.conversationId, text || documents[0]?.fileName || "Comprobante");
    const userAt = this.deps.now();
    const userMessageId = await this.appendMessage(conversationId, { role: "user", text: text || undefined, authorUserId: actor.userId, documentIds }, userAt);
    const { blocks, result, extraction, documentId } = await this.respond(ledger, text, documents);
    const replyAt = new Date(Math.max(this.deps.now().getTime(), userAt.getTime() + 1));
    const replyId = await this.appendMessage(conversationId, { role: "assistant", blocks }, replyAt);
    await this.persistProposals(conversationId, replyId, result, extraction, documentId);
    return {
      conversationId,
      userMessage: { id: userMessageId, role: "user", at: this.stamp(ledger, userAt), text: text || undefined, attachments: documents.map(toAttachment) },
      reply: { id: replyId, role: "assistant", at: this.stamp(ledger, replyAt), blocks },
    };
  }

  async choose(actor: Actor, input: { conversationId: string; choiceId: string; optionId: string; label: string; context: { supplierId: string; amount: number; date?: string; method?: "transferencia" | "efectivo" | "cheque" | "otro" } }): Promise<{ messages: ChatMessage[] }> {
    const ledger = await this.ledger();
    const today = localDate(this.deps.now(), ledger.tz);
    // Mark the choice as resolved in the stored message.
    const rows = await this.db.select().from(t.chatMessages).where(eq(t.chatMessages.conversationId, input.conversationId));
    for (const row of rows) {
      if (!row.blocks?.includes(input.choiceId)) continue;
      const blocks = (JSON.parse(row.blocks) as AssistantBlock[]).map((b) => (b.type === "choice" && b.id === input.choiceId ? { ...b, selected: input.optionId, resolved: true } : b));
      await this.db.update(t.chatMessages).set({ blocks: JSON.stringify(blocks) }).where(eq(t.chatMessages.id, row.id));
    }
    const at = this.deps.now();
    const userId = await this.appendMessage(input.conversationId, { role: "user", text: input.label, authorUserId: actor.userId }, at);
    const result = resolvePaymentChoice(ledger, input.optionId, input.context, today);
    const replyAt = new Date(at.getTime() + 1);
    const replyId = await this.appendMessage(input.conversationId, { role: "assistant", blocks: result.blocks }, replyAt);
    await this.persistProposals(input.conversationId, replyId, result, undefined);
    return {
      messages: [
        { id: userId, role: "user", at: this.stamp(ledger, at), text: input.label },
        { id: replyId, role: "assistant", at: this.stamp(ledger, replyAt), blocks: result.blocks },
      ],
    };
  }

  private async pendingRow(id: string) {
    const [row] = await this.db.select().from(t.aiInterpretations).where(eq(t.aiInterpretations.id, id));
    if (!row || row.projectId !== this.deps.projectId) throw new DomainError("not_found", "La propuesta no existe.");
    if (row.status !== "pending") throw new DomainError("conflict", row.status === "confirmed" ? "Esta propuesta ya fue confirmada." : "Esta propuesta fue cancelada.");
    return row;
  }

  /** Re-resolves an edited proposal (supplier/material/order matches, balances) without writing domain data. */
  async revise(id: string, interpretation: Interpretation): Promise<Interpretation> {
    const row = await this.pendingRow(id);
    const original = JSON.parse(row.proposal) as Interpretation;
    if (original.kind !== interpretation.kind) throw new DomainError("validation", "La propuesta cambió de tipo.");
    const revised = reviseInterpretation(await this.ledger(), interpretation);
    await this.db.update(t.aiInterpretations).set({ proposal: JSON.stringify(revised) }).where(eq(t.aiInterpretations.id, id));
    return revised;
  }

  /** The only path from an AI proposal to the domain: validated command + audit, then the chat records the outcome. */
  async confirm(actor: Actor, id: string, interpretation: Interpretation): Promise<ConfirmResponse> {
    const row = await this.pendingRow(id);
    const original = JSON.parse(row.proposal) as Interpretation;
    if (original.kind !== interpretation.kind) throw new DomainError("validation", "La propuesta cambió de tipo.");
    // Documents can only be the one analyzed for this proposal.
    if (interpretation.document?.documentId && interpretation.document.documentId !== row.documentId && interpretation.document.documentId !== original.document?.documentId) {
      const [doc] = await this.db.select().from(t.documents).where(eq(t.documents.id, interpretation.document.documentId));
      if (!doc || doc.projectId !== this.deps.projectId) throw new DomainError("not_found", "El documento adjunto no existe.");
    }
    const ledger = await this.ledger();
    const final = reviseInterpretation(ledger, interpretation);
    const ctx = this.commandContext(actor, "assistant", id);
    const outcome = await confirmInterpretation(ctx, ledger, final, () => this.ledger());
    const resolvedAt = this.deps.now();
    await this.db
      .update(t.aiInterpretations)
      .set({
        status: "confirmed",
        confirmedProposal: JSON.stringify(final),
        result: JSON.stringify(outcome.result),
        resultEntityType: outcome.entityType,
        resultEntityId: outcome.entityId,
        resolvedAt: resolvedAt.toISOString(),
        resolvedBy: actor.userId,
      })
      .where(eq(t.aiInterpretations.id, id));
    const messages: ChatMessage[] = [];
    if (row.conversationId) {
      const fresh = await this.ledger();
      const userAt = this.deps.now();
      const userText = CONFIRM_LABEL[final.kind];
      const userId = await this.appendMessage(row.conversationId, { role: "user", text: userText, authorUserId: actor.userId }, userAt);
      const blocks: AssistantBlock[] = [
        { type: "interpretation", id: `${id}-result`, interpretation: final, state: "confirmed", result: outcome.result },
        { type: "text", text: FOLLOW_UP[final.kind] },
      ];
      const replyAt = new Date(userAt.getTime() + 1);
      const replyId = await this.appendMessage(row.conversationId, { role: "assistant", blocks }, replyAt);
      messages.push({ id: userId, role: "user", at: this.stamp(fresh, userAt), text: userText }, { id: replyId, role: "assistant", at: this.stamp(fresh, replyAt), blocks });
    }
    return { result: outcome.result, messages };
  }

  async cancel(actor: Actor, id: string): Promise<void> {
    await this.pendingRow(id);
    await this.db.update(t.aiInterpretations).set({ status: "cancelled", resolvedAt: this.deps.now().toISOString(), resolvedBy: actor.userId }).where(eq(t.aiInterpretations.id, id));
  }

  /** Undo of a confirmed record: voids it through the domain (audited, nothing deleted). */
  async undo(actor: Actor, input: { recordId: string; conversationId?: string }): Promise<{ messages: ChatMessage[] }> {
    const [type, entityId, extra] = input.recordId.split(":");
    if (!entityId) throw new DomainError("validation", "Registro inválido.");
    const ctx = this.commandContext(actor, "assistant");
    if (type === "allocation") await voidAllocations(ctx, entityId, (extra ?? "").split(",").filter(Boolean));
    else if (type === "order" || type === "delivery" || type === "payment") await voidRecord(ctx, type, entityId, "Deshecho desde el asistente");
    else throw new DomainError("validation", "Registro inválido.");
    const rows = await this.db.select().from(t.aiInterpretations).where(and(eq(t.aiInterpretations.projectId, this.deps.projectId), eq(t.aiInterpretations.status, "confirmed")));
    const match = rows.find((r) => r.result && (JSON.parse(r.result) as ConfirmResult).recordId === input.recordId);
    if (match) await this.db.update(t.aiInterpretations).set({ status: "undone" }).where(eq(t.aiInterpretations.id, match.id));
    const messages: ChatMessage[] = [];
    const conversationId = input.conversationId ?? match?.conversationId ?? undefined;
    if (conversationId) {
      const ledger = await this.ledger();
      const at = this.deps.now();
      const blocks: AssistantBlock[] = [{ type: "text", text: "Deshice el registro: quedó anulado y fuera de los saldos. El historial conserva lo que pasó." }];
      const id = await this.appendMessage(conversationId, { role: "assistant", blocks }, at);
      messages.push({ id, role: "assistant", at: this.stamp(ledger, at), blocks });
    }
    return { messages };
  }
}
