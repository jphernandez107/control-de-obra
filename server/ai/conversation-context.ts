import { desc, eq } from "drizzle-orm";
import type { AssistantBlock } from "../../src/domain/assistant";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import type { Ledger } from "../domain/derive";
import type { AIConversationContext } from "./provider";

// Builds the small slice of conversation a provider gets: the last few
// turns as short text, plus the entity the latest reply was about. Replies
// store only record ids (`chat_messages.context_refs`), so a follow-up such
// as "¿y cuánto falta pagar?" resolves to a record whose figures are read
// fresh from the database. A reply about several orders gives no focus, so
// the assistant asks instead of guessing.

export interface ContextRefs {
  orderIds: string[];
  supplierIds: string[];
  materialIds: string[];
}

export const emptyRefs = (): ContextRefs => ({ orderIds: [], supplierIds: [], materialIds: [] });

export function mergeRefs(...refs: Partial<ContextRefs>[]): ContextRefs {
  const out = emptyRefs();
  for (const r of refs) {
    for (const key of ["orderIds", "supplierIds", "materialIds"] as const) for (const id of r[key] ?? []) if (!out[key].includes(id)) out[key].push(id);
  }
  return out;
}

export interface ConversationFocus {
  orderId?: string;
  supplierId?: string;
  materialId?: string;
}

export interface ConversationState {
  context: AIConversationContext;
  focus: ConversationFocus;
}

export interface StoredMessage {
  role: string;
  text: string | null;
  blocks: string | null;
  contextRefs: string | null;
}

const MAX_MESSAGES = 6;
const MAX_CHARS = 280;

function messageText(m: StoredMessage): string {
  if (m.text) return m.text;
  if (!m.blocks) return "";
  try {
    return (JSON.parse(m.blocks) as AssistantBlock[])
      .filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ");
  } catch {
    return "";
  }
}

function parseRefs(raw: string | null): ContextRefs | null {
  if (!raw) return null;
  try {
    return mergeRefs(JSON.parse(raw) as Partial<ContextRefs>);
  } catch {
    return null;
  }
}

/** Pure part: `messages` newest first. */
export function buildConversationContext(messages: StoredMessage[], ledger: Ledger): ConversationState {
  const recent = messages
    .slice(0, MAX_MESSAGES)
    .reverse()
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: messageText(m).replace(/\s+/g, " ").trim().slice(0, MAX_CHARS) }))
    .filter((m) => m.text);
  const focus: ConversationFocus = {};
  // Only the most recent reply that was about something counts.
  const latest = messages.slice(0, MAX_MESSAGES).map((m) => parseRefs(m.contextRefs)).find((r) => r && (r.orderIds.length || r.supplierIds.length || r.materialIds.length));
  if (latest) {
    const order = latest.orderIds.length === 1 ? ledger.order(latest.orderIds[0]!) : undefined;
    if (order) focus.orderId = order.id;
    const supplierId = latest.supplierIds.length === 1 ? latest.supplierIds[0] : order?.supplierId;
    if (supplierId && ledger.supplier(supplierId)) focus.supplierId = supplierId;
    if (latest.materialIds.length === 1 && ledger.material(latest.materialIds[0]!)) focus.materialId = latest.materialIds[0];
  }
  const order = focus.orderId ? ledger.order(focus.orderId) : undefined;
  return {
    focus,
    context: {
      recent,
      focus: {
        order: order ? { reference: ledger.orderNumber(order), supplier: ledger.supplierName(order.supplierId) } : undefined,
        supplier: focus.supplierId ? ledger.supplierName(focus.supplierId) : undefined,
        material: focus.materialId ? ledger.material(focus.materialId)?.name : undefined,
      },
    },
  };
}

export async function loadConversationContext(db: AppDb, conversationId: string | undefined, ledger: Ledger): Promise<ConversationState> {
  if (!conversationId) return { focus: {}, context: { recent: [], focus: {} } };
  const rows = await db
    .select({ role: t.chatMessages.role, text: t.chatMessages.text, blocks: t.chatMessages.blocks, contextRefs: t.chatMessages.contextRefs })
    .from(t.chatMessages)
    .where(eq(t.chatMessages.conversationId, conversationId))
    .orderBy(desc(t.chatMessages.createdAt))
    .limit(MAX_MESSAGES);
  return buildConversationContext(rows, ledger);
}
