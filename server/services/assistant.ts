import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { AssistantBlock, Attachment, ChatMessage, ConfirmResponse, ConfirmResult, Conversation, Interpretation } from "../../src/domain/assistant";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { answerQuestion } from "../ai/answers";
import { loadConversationContext, mergeRefs, type ContextRefs, type ConversationState } from "../ai/conversation-context";
import type { DocumentContentExtractor } from "../ai/document-content";
import { AI_ERROR_HINTS, AI_ERROR_MESSAGES, AIError, isAIError, toAIError } from "../ai/errors";
import { validationColumns, withValidation } from "../ai/pending-actions";
import type { AIProjectContext, AIProvider } from "../ai/provider";
import { proposeAllocation, proposeDelivery, proposeOrder, proposePayment, resolvePaymentChoice, type ProposalResult } from "../ai/proposals";
import { confirmInterpretation, reviseInterpretation, staleProposal } from "../ai/review";
import { parseInterpretationResult, type AIInterpretationResult } from "../ai/schemas";
import type { Ledger } from "../domain/derive";
import { DomainError } from "../domain/errors";
import { formatNumber } from "../../src/domain/format";
import { fromMilli } from "../domain/quantity";
import { localDate, localDateTime } from "../domain/time";
import type { DocumentStorage } from "../storage/storage";
import { voidAllocations, voidRecord } from "./commands";
import { newId, type Actor, type CommandContext } from "./context";
import { ledgerFor } from "./queries";

// Conversation layer of the assistant. Chat history is stored for display
// only; every answer and proposal is computed from the domain tables, and
// writes happen exclusively through confirm() → validated domain commands.

export interface AssistantDeps {
  db: AppDb;
  projectId: string;
  provider: AIProvider;
  /** Turns a stored document into normalized text; interpretation never touches storage. */
  extractor: DocumentContentExtractor;
  storage: DocumentStorage;
  now: () => Date;
  /** Per-user guard against bursts and double submissions, so a stuck button cannot drain the AI quota. */
  limits?: AssistantLimits;
}

export interface AssistantLimits {
  maxMessagesPerMinute: number;
  duplicateWindowMs: number;
}

/** What one interpretation produced, before it is stored. */
interface Reply {
  blocks: AssistantBlock[];
  result?: ProposalResult;
  interpretation?: AIInterpretationResult;
  refs?: Partial<ContextRefs>;
  documentId?: string;
}

type DocumentRow = typeof t.documents.$inferSelect;

const CONFIRM_LABEL: Record<Interpretation["kind"], string> = { order: "Confirmar pedido", delivery: "Confirmar entrega", payment: "Confirmar pago" };
const CONFIRM_LABELS = new Set(Object.values(CONFIRM_LABEL));
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

/** Spanish, user-facing state for any AI failure. Non-AI errors propagate. */
function aiErrorBlocks(error: unknown): AssistantBlock[] {
  if (!isAIError(error)) throw error;
  return [{ type: "ai_error", code: error.code, message: `${error.message} No se guardó nada.`, hint: AI_ERROR_HINTS[error.code] }];
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

  private async appendMessage(
    conversationId: string,
    message: { role: "user" | "assistant"; text?: string; blocks?: AssistantBlock[]; authorUserId?: string; documentIds?: string[]; refs?: Partial<ContextRefs> },
    at: Date,
  ): Promise<string> {
    const refs = message.refs ? mergeRefs(message.refs) : null;
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
        contextRefs: refs && (refs.orderIds.length || refs.supplierIds.length || refs.materialIds.length) ? JSON.stringify(refs) : null,
        createdAt,
      }),
      ...(message.documentIds ?? []).map((documentId) => this.db.insert(t.messageAttachments).values({ id: newId(), messageId: id, documentId })),
      this.db.update(t.conversations).set({ updatedAt: createdAt }).where(eq(t.conversations.id, conversationId)),
    ] as unknown as Parameters<AppDb["batch"]>[0]);
    return id;
  }

  private projectContext(ledger: Ledger, today: string): AIProjectContext {
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

  /** Calls the provider for a message or document and validates its output. Throws AIError only. */
  private async interpret(ledger: Ledger, today: string, text: string, doc: DocumentRow | undefined, conversation: ConversationState): Promise<AIInterpretationResult> {
    const project = this.projectContext(ledger, today);
    try {
      if (doc) {
        const content = await this.deps.extractor.extract({ id: doc.id, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, sha256: doc.sha256 });
        if (!content.text.trim()) throw new AIError("AI_DOCUMENT_UNSUPPORTED", "unreadable");
        const raw = await this.deps.provider.analyzeDocument({
          document: { id: doc.id, fileName: doc.fileName, mimeType: doc.mimeType },
          content,
          userText: text || undefined,
          project,
          conversation: conversation.context,
        });
        return parseInterpretationResult(raw);
      }
      return parseInterpretationResult(await this.deps.provider.interpret({ text, project, conversation: conversation.context }));
    } catch (error) {
      throw toAIError(error);
    }
  }

  /** Interprets a message (and optional document) into answers or pending proposals. Never writes domain data. */
  private async respond(ledger: Ledger, text: string, documents: DocumentRow[], conversationId: string): Promise<Reply> {
    const today = localDate(this.deps.now(), ledger.tz);
    const conversation = await loadConversationContext(this.db, conversationId, ledger);
    const doc = documents[0];
    if (doc && (doc.mimeType === "text/csv" || doc.mimeType.includes("spreadsheet"))) {
      return {
        blocks: [
          { type: "text", text: "Las planillas de cómputo se cargan desde Materiales y cómputo → Cargar cómputo. Aquí puedo leer comprobantes de pedido, remitos y comprobantes de pago (PDF o foto)." },
          { type: "actions", actions: [{ label: "Ir a Materiales", icon: "clipboard-list", link: { to: "/materiales" } }] },
        ],
      };
    }
    let interpreted: AIInterpretationResult;
    try {
      interpreted = await this.interpret(ledger, today, text, doc, conversation);
    } catch (error) {
      // A document without readable text gets the "take another photo" card.
      if (doc && isAIError(error) && error.code === "AI_DOCUMENT_UNSUPPORTED" && error.message === "unreadable") return { blocks: [{ type: "read_error", fileName: doc.fileName }], documentId: doc.id };
      if (doc && isAIError(error) && error.code === "AI_DOCUMENT_UNSUPPORTED" && error.message === AI_ERROR_MESSAGES.AI_DOCUMENT_UNSUPPORTED) {
        return { blocks: aiErrorBlocks(new AIError("AI_DOCUMENT_UNSUPPORTED", `No puedo leer archivos ${doc.mimeType.split("/")[1]?.toUpperCase() ?? ""}.`)), documentId: doc.id };
      }
      return { blocks: aiErrorBlocks(error) };
    }
    const i = interpreted.interpretation;
    const attachment = doc ? toAttachment(doc) : undefined;
    if (doc) {
      const classification = interpreted.document;
      if (!classification || classification.type === "unknown" || i.intent === "unknown") {
        return {
          blocks: [{ type: "text", text: `No reconocí ${doc.fileName} como comprobante de pedido, remito ni comprobante de pago. Cuéntame qué es o escribe los datos y lo registro.` }],
          interpretation: interpreted,
          documentId: doc.id,
        };
      }
      if (classification.confidence < 0.5 || i.confidence < 0.5) {
        return { blocks: aiErrorBlocks(new AIError("AI_INTERPRETATION_AMBIGUOUS")), interpretation: interpreted, documentId: doc.id };
      }
    }
    const options = { document: attachment, focusOrderId: conversation.focus.orderId };
    let result: ProposalResult;
    switch (i.intent) {
      case "create_order":
        result = proposeOrder(ledger, i, today, options);
        break;
      case "register_delivery":
      case "complete_order_delivery":
        result = proposeDelivery(ledger, i, today, options);
        break;
      case "create_supplier_payment":
      case "pay_order_balance":
        result = proposePayment(ledger, i, today, options);
        break;
      case "allocate_payment":
        result = proposeAllocation(ledger, i);
        break;
      case "ask_project_question": {
        const answer = await answerQuestion(ledger, i, { provider: this.deps.provider, conversation, question: text, today });
        return { blocks: answer.blocks, refs: answer.refs, interpretation: interpreted };
      }
      case "clarification_required":
        return { blocks: [{ type: "text", text: i.question }], interpretation: interpreted, refs: conversation.focus.orderId ? { orderIds: [conversation.focus.orderId] } : undefined };
      case "unknown":
        return {
          blocks: [
            {
              type: "text",
              text: i.note
                ? `${i.note} Puedo registrar pedidos, entregas y pagos, o responder sobre saldos y pendientes.`
                : "Puedo registrar pedidos, entregas y pagos, o responder sobre saldos y pendientes. Prueba con algo como «Llegaron las 20 barras del 12» o «¿Cuánto debemos a Hierros Córdoba?».",
            },
          ],
          interpretation: interpreted,
        };
    }
    if (i.note && result.proposals.length) result.blocks.splice(1, 0, { type: "note", text: i.note });
    this.attachValidation(ledger, result);
    return { blocks: result.blocks, result, interpretation: interpreted, refs: result.refs, documentId: doc?.id };
  }

  /** Validates every proposal of a reply and shows the result on its card. */
  private attachValidation(ledger: Ledger, result: ProposalResult) {
    for (const p of result.proposals) {
      p.interpretation = withValidation(ledger, p.interpretation);
      for (const b of result.blocks) if (b.type === "interpretation" && b.id === p.id) b.interpretation = p.interpretation;
    }
  }

  private async persistProposals(conversationId: string, messageId: string, reply: Reply) {
    const result = reply.result;
    if (!result?.proposals.length) return;
    const createdAt = this.deps.now().toISOString();
    const meta = reply.interpretation?.meta;
    await this.db.batch(
      result.proposals.map((p) =>
        this.db.insert(t.aiInterpretations).values({
          id: p.id,
          projectId: this.deps.projectId,
          conversationId,
          messageId,
          documentId: reply.documentId ?? null,
          provider: meta?.provider ?? this.deps.provider.name,
          model: meta?.model ?? this.deps.provider.model ?? null,
          intent: p.intent,
          confidence: reply.interpretation ? Math.round(reply.interpretation.interpretation.confidence * 100) : null,
          // The validated, application-owned interpretation — never a vendor response object.
          providerOutput: reply.interpretation ? JSON.stringify({ interpretation: reply.interpretation.interpretation, document: reply.interpretation.document }) : null,
          proposal: JSON.stringify(p.interpretation),
          ...validationColumns(p.interpretation.validation),
          status: "pending",
          createdAt,
        }),
      ) as unknown as Parameters<AppDb["batch"]>[0],
    );
  }

  private async guardAIUse(actor: Actor, text: string, documentIds: string[], limits: AssistantLimits) {
    const now = this.deps.now().getTime();
    const recent = await this.db
      .select({ id: t.chatMessages.id, text: t.chatMessages.text, createdAt: t.chatMessages.createdAt })
      .from(t.chatMessages)
      .innerJoin(t.conversations, eq(t.chatMessages.conversationId, t.conversations.id))
      .where(
        and(
          eq(t.conversations.projectId, this.deps.projectId),
          eq(t.chatMessages.authorUserId, actor.userId),
          eq(t.chatMessages.role, "user"),
          gt(t.chatMessages.createdAt, new Date(now - Math.max(60_000, limits.duplicateWindowMs)).toISOString()),
        ),
      );
    const asked = recent.filter((m) => !CONFIRM_LABELS.has(m.text ?? ""));
    if (asked.filter((m) => Date.parse(m.createdAt) > now - 60_000).length >= limits.maxMessagesPerMinute) {
      throw new DomainError("rate_limited", "Enviaste muchos mensajes seguidos. Espera un minuto y vuelve a intentar.");
    }
    const sameText = asked.filter((m) => Date.parse(m.createdAt) > now - limits.duplicateWindowMs && (m.text ?? "") === text);
    if (!sameText.length) return;
    const attached = await this.db.select().from(t.messageAttachments).where(inArray(t.messageAttachments.messageId, sameText.map((m) => m.id)));
    const key = [...documentIds].sort().join(",");
    if (sameText.some((m) => attached.filter((a) => a.messageId === m.id).map((a) => a.documentId).sort().join(",") === key)) {
      throw new DomainError("conflict", "Ese mensaje ya se envió hace un momento.");
    }
  }

  async send(actor: Actor, input: { conversationId?: string; text?: string; documentIds?: string[] }): Promise<{ conversationId: string; userMessage: ChatMessage; reply: ChatMessage }> {
    const text = input.text?.trim() ?? "";
    const documentIds = input.documentIds ?? [];
    if (!text && !documentIds.length) throw new DomainError("validation", "Escribe un mensaje o adjunta un comprobante.");
    if (this.deps.limits) await this.guardAIUse(actor, text, documentIds, this.deps.limits);
    const documents = documentIds.length ? await this.db.select().from(t.documents).where(inArray(t.documents.id, documentIds.slice(0, 5))) : [];
    if (documents.some((d) => d.projectId !== this.deps.projectId) || documents.length !== documentIds.length) throw new DomainError("not_found", "El documento adjunto no existe.");
    const ledger = await this.ledger();
    const conversationId = await this.ensureConversation(actor, input.conversationId, text || documents[0]?.fileName || "Comprobante");
    const userAt = this.deps.now();
    const userMessageId = await this.appendMessage(conversationId, { role: "user", text: text || undefined, authorUserId: actor.userId, documentIds }, userAt);
    const reply = await this.respond(ledger, text, documents, conversationId);
    const blocks = reply.blocks;
    const replyAt = new Date(Math.max(this.deps.now().getTime(), userAt.getTime() + 1));
    const replyId = await this.appendMessage(conversationId, { role: "assistant", blocks, refs: reply.refs }, replyAt);
    await this.persistProposals(conversationId, replyId, reply);
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
    this.attachValidation(ledger, result);
    const replyAt = new Date(at.getTime() + 1);
    const replyId = await this.appendMessage(input.conversationId, { role: "assistant", blocks: result.blocks, refs: { supplierIds: [input.context.supplierId] } }, replyAt);
    await this.persistProposals(input.conversationId, replyId, { blocks: result.blocks, result });
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
    const ledger = await this.ledger();
    const revised = withValidation(ledger, reviseInterpretation(ledger, interpretation));
    await this.db
      .update(t.aiInterpretations)
      .set({ proposal: JSON.stringify(revised), ...validationColumns(revised.validation) })
      .where(eq(t.aiInterpretations.id, id));
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
    // Revalidate against current data: recompute every derived value and refuse stale or blocked proposals.
    const ledger = await this.ledger();
    const final = withValidation(ledger, reviseInterpretation(ledger, interpretation));
    const stale = staleProposal(ledger, interpretation, final);
    if (stale) {
      const refreshed = withValidation(ledger, stale.interpretation);
      await this.db
        .update(t.aiInterpretations)
        .set({ proposal: JSON.stringify(refreshed), ...validationColumns(refreshed.validation) })
        .where(eq(t.aiInterpretations.id, id));
      throw new DomainError("stale_proposal", stale.message, refreshed);
    }
    const blocking = final.validation?.issues.filter((x) => x.severity === "error") ?? [];
    if (blocking.length) throw new DomainError("validation", `No se puede confirmar todavía: ${blocking.map((x) => x.message).join(" ")}`);
    const ctx = this.commandContext(actor, "assistant", id);
    const outcome = await confirmInterpretation(ctx, ledger, final, () => this.ledger());
    const resolvedAt = this.deps.now();
    await this.db
      .update(t.aiInterpretations)
      .set({
        status: "confirmed",
        confirmedProposal: JSON.stringify(final),
        ...validationColumns(final.validation),
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
      const replyId = await this.appendMessage(row.conversationId, { role: "assistant", blocks, refs: refsOfOutcome(final, outcome.entityType, outcome.entityId) }, replyAt);
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

/** What a confirmation reply is about, so "¿y cuánto falta pagar?" works right after confirming. */
function refsOfOutcome(i: Interpretation, entityType: string, entityId: string): Partial<ContextRefs> {
  if (entityType === "order") return { orderIds: [entityId], supplierIds: i.kind === "order" && i.supplierId ? [i.supplierId] : [] };
  if (i.kind === "delivery") return { orderIds: [i.orderId], supplierIds: i.supplierId ? [i.supplierId] : [] };
  if (i.kind === "payment") return { orderIds: i.allocation.type === "order" ? [i.allocation.orderId] : [], supplierIds: [i.supplierId] };
  return {};
}
