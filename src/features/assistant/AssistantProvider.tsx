import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssistantBlock, AssistantInput, Attachment, ChatMessage, Interpretation } from "@/domain/assistant";
import { useServices } from "@/services";
import { errorMessage } from "@/services/api/client";
import { useInvalidateAll } from "@/queries";
import { useToast } from "@/components/ui/Toast";

type InterpretationBlock = Extract<AssistantBlock, { type: "interpretation" }>;

interface AssistantContextValue {
  messages: ChatMessage[];
  today: string;
  ready: boolean;
  busy: boolean;
  pendingCount: number;
  conversationId: string | null;
  send: (input: AssistantInput) => Promise<void>;
  updateInterpretation: (blockId: string, interpretation: Interpretation) => void;
  confirm: (blockId: string) => Promise<void>;
  cancel: (blockId: string) => Promise<void>;
  undo: (recordId: string) => Promise<void>;
  chooseOption: (choiceId: string, optionId: string) => void;
  continueChoice: (choiceId: string) => Promise<void>;
  openConversation: (conversationId: string) => Promise<void>;
  startConversation: () => Promise<void>;
  /** Text another screen wants placed in the composer when the assistant opens. */
  draft: string;
  setDraft: (text: string) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

let projectToday = "";

/** Local timestamp for optimistic messages, on the project's current date. */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = projectToday || `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Files picked in this session, by attachment id, until they are uploaded. */
const pendingFiles = new Map<string, File>();

function mapBlocks(messages: ChatMessage[], fn: (block: AssistantBlock) => AssistantBlock): ChatMessage[] {
  return messages.map((m) => (m.blocks ? { ...m, blocks: m.blocks.map(fn) } : m));
}

function findInterpretation(messages: ChatMessage[], blockId: string): InterpretationBlock | undefined {
  for (const m of messages) {
    for (const b of m.blocks ?? []) if (b.type === "interpretation" && b.id === blockId) return b;
  }
  return undefined;
}

/** Edits that change which records a proposal points at; the server re-resolves them. */
function needsRevision(before: Interpretation, after: Interpretation): boolean {
  if (before.kind === "order" && after.kind === "order") {
    return before.supplierName !== after.supplierName || before.items.length !== after.items.length || before.items.some((it, i) => it.material !== after.items[i]?.material || it.materialId !== after.items[i]?.materialId);
  }
  if (before.kind === "delivery" && after.kind === "delivery") return before.orderNumber !== after.orderNumber;
  if (before.kind === "payment" && after.kind === "payment") return true;
  return false;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { assistant, documents } = useServices();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [today, setToday] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;

  const load = useCallback(
    async (id?: string) => {
      const thread = await assistant.initialThread(id);
      projectToday = thread.today;
      setToday(thread.today);
      setConversationId(thread.conversationId);
      setMessages(thread.messages);
      setReady(true);
    },
    [assistant],
  );

  useEffect(() => {
    let alive = true;
    load().catch(() => {
      if (!alive) return;
      setReady(true);
      setMessages([{ id: uid("m"), role: "assistant", at: stamp(), blocks: [{ type: "text", text: "No pude conectarme con el servidor. Revisa que la API esté en marcha y recarga la página." }] }]);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  const append = useCallback((...items: ChatMessage[]) => setMessages((prev) => [...prev, ...items]), []);

  const send = useCallback(
    async (input: AssistantInput) => {
      const text = input.text?.trim();
      if (!text && !input.attachments?.length) return;
      const localUserId = uid("m");
      const replyId = uid("m");
      const analyzing = Boolean(input.attachments?.length);
      append(
        { id: localUserId, role: "user", at: stamp(), text, attachments: input.attachments },
        { id: replyId, role: "assistant", at: stamp(), blocks: [], status: analyzing ? "Asistente · analizando" : "Asistente · escribiendo" },
      );
      setBusy(true);
      try {
        const documentIds: string[] = [];
        for (const attachment of input.attachments ?? []) {
          if (attachment.documentId) {
            documentIds.push(attachment.documentId);
            continue;
          }
          const file = pendingFiles.get(attachment.id);
          if (!file) throw new Error("missing file");
          const uploaded = await documents.upload(file);
          pendingFiles.delete(attachment.id);
          documentIds.push(uploaded.id);
        }
        const result = await assistant.respond(
          { text, conversationId: conversationRef.current, documentIds },
          {
            onProgress: (title, steps) => setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, blocks: [{ type: "analysis", title, steps }] } : m))),
          },
        );
        setConversationId(result.conversationId);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === localUserId) return { ...result.userMessage, attachments: input.attachments?.map((a, i) => ({ ...a, documentId: documentIds[i] })) };
            if (m.id === replyId) return result.reply;
            return m;
          }),
        );
      } catch (error) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? { ...m, status: undefined, blocks: [{ type: "text", text: `${errorMessage(error, "No pude procesar el mensaje.")} No se guardó nada; intenta de nuevo en un momento.` }] }
              : m,
          ),
        );
      } finally {
        setBusy(false);
        invalidate();
      }
    },
    [append, assistant, documents, invalidate],
  );

  const setBlock = (blockId: string, patch: Partial<InterpretationBlock>) =>
    setMessages((prev) => mapBlocks(prev, (b) => (b.type === "interpretation" && b.id === blockId ? { ...b, ...patch } : b)));

  const updateInterpretation = useCallback(
    (blockId: string, interpretation: Interpretation) => {
      const before = findInterpretation(messagesRef.current, blockId)?.interpretation;
      setBlock(blockId, { interpretation });
      if (!before || !needsRevision(before, interpretation)) return;
      assistant
        .revise(blockId, interpretation)
        .then((revised) => setBlock(blockId, { interpretation: revised }))
        .catch((error) => toast(errorMessage(error, "No pude actualizar la propuesta."), "info"));
    },
    [assistant, toast],
  );

  const confirm = useCallback(
    async (blockId: string) => {
      const block = findInterpretation(messagesRef.current, blockId);
      if (!block || block.state !== "pending") return;
      setBlock(blockId, { state: "confirming" });
      try {
        const { result, messages: appended } = await assistant.confirm(blockId, block.interpretation);
        setBlock(blockId, { state: "confirmed", result });
        append(...appended);
        invalidate();
      } catch (error) {
        setBlock(blockId, { state: "pending" });
        toast(errorMessage(error, "No se pudo guardar. Intenta de nuevo."), "info");
      }
    },
    [append, assistant, invalidate, toast],
  );

  const cancel = useCallback(
    async (blockId: string) => {
      setBlock(blockId, { state: "cancelled" });
      try {
        await assistant.cancel(blockId);
      } catch {
        // Already resolved elsewhere; the card stays cancelled.
      }
      invalidate();
    },
    [assistant, invalidate],
  );

  const undo = useCallback(
    async (recordId: string) => {
      try {
        const { messages: appended } = await assistant.undo(recordId, conversationRef.current);
        setMessages((prev) => mapBlocks(prev, (b) => (b.type === "interpretation" && b.result?.recordId === recordId ? { ...b, state: "cancelled", result: undefined } : b)));
        append(...appended);
        invalidate();
        toast("Registro deshecho", "info");
      } catch (error) {
        toast(errorMessage(error, "No se pudo deshacer."), "info");
      }
    },
    [append, assistant, invalidate, toast],
  );

  const chooseOption = useCallback((choiceId: string, optionId: string) => {
    setMessages((prev) => mapBlocks(prev, (b) => (b.type === "choice" && b.id === choiceId ? { ...b, selected: optionId } : b)));
  }, []);

  const continueChoice = useCallback(
    async (choiceId: string) => {
      let choice: Extract<AssistantBlock, { type: "choice" }> | undefined;
      for (const m of messagesRef.current) for (const b of m.blocks ?? []) if (b.type === "choice" && b.id === choiceId) choice = b;
      const conversation = conversationRef.current;
      if (!choice || choice.resolved || !conversation) return;
      const option = choice.options.find((o) => o.id === choice!.selected);
      setMessages((prev) => mapBlocks(prev, (b) => (b.type === "choice" && b.id === choiceId ? { ...b, resolved: true } : b)));
      setBusy(true);
      try {
        const { messages: appended } = await assistant.resolveChoice({ conversationId: conversation, choiceId, optionId: choice.selected, label: option?.title ?? "Continuar", context: choice.context });
        append(...appended);
      } catch (error) {
        setMessages((prev) => mapBlocks(prev, (b) => (b.type === "choice" && b.id === choiceId ? { ...b, resolved: false } : b)));
        toast(errorMessage(error), "info");
      } finally {
        setBusy(false);
      }
    },
    [append, assistant, toast],
  );

  const openConversation = useCallback(
    async (id: string) => {
      try {
        await load(id);
      } catch (error) {
        toast(errorMessage(error, "No se pudo abrir la conversación."), "info");
      }
    },
    [load, toast],
  );

  const startConversation = useCallback(async () => {
    try {
      const { conversationId: id } = await assistant.newConversation();
      setConversationId(id);
      setMessages([]);
    } catch (error) {
      toast(errorMessage(error), "info");
    }
  }, [assistant, toast]);

  const pendingCount = useMemo(
    () => messages.reduce((n, m) => n + (m.blocks ?? []).filter((b) => b.type === "interpretation" && (b.state === "pending" || b.state === "confirming") && !b.id.endsWith("-result")).length, 0),
    [messages],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({ messages, today, ready, busy, pendingCount, conversationId, send, updateInterpretation, confirm, cancel, undo, chooseOption, continueChoice, openConversation, startConversation, draft, setDraft }),
    [messages, today, ready, busy, pendingCount, conversationId, send, updateInterpretation, confirm, cancel, undo, chooseOption, continueChoice, openConversation, startConversation, draft],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
}

const ACCEPTED = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;

export function fileToAttachment(file: File): Attachment {
  const kb = file.size / 1024;
  const sizeLabel = kb > 1024 ? `${(kb / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(kb))} KB`;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const attachment: Attachment = {
    id: uid("att"),
    fileName: file.name,
    format: isPdf ? "pdf" : "image",
    sizeLabel,
    previewUrl: isPdf || !file.type.startsWith("image/") ? undefined : URL.createObjectURL(file),
  };
  pendingFiles.set(attachment.id, file);
  return attachment;
}

/** Whether a picked file is a format the assistant can read (PDF or photo). */
export function isSupportedAttachment(file: File): boolean {
  return ACCEPTED.test(file.type) || /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(file.name);
}
