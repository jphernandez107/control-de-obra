import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssistantBlock, AssistantInput, Attachment, ChatMessage, Interpretation } from "@/domain/assistant";
import { useServices } from "@/services";
import { useInvalidateAll } from "@/queries";
import { useToast } from "@/components/ui/Toast";

type InterpretationBlock = Extract<AssistantBlock, { type: "interpretation" }>;

interface AssistantContextValue {
  messages: ChatMessage[];
  today: string;
  ready: boolean;
  busy: boolean;
  pendingCount: number;
  send: (input: AssistantInput) => Promise<void>;
  updateInterpretation: (blockId: string, interpretation: Interpretation) => void;
  confirm: (blockId: string) => Promise<void>;
  cancel: (blockId: string) => Promise<void>;
  undo: (recordId: string) => Promise<void>;
  chooseOption: (choiceId: string, optionId: string) => void;
  continueChoice: (choiceId: string) => Promise<void>;
  /** Text another screen wants placed in the composer when the assistant opens. */
  draft: string;
  setDraft: (text: string) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

let projectToday = "";

/** New messages use the project's current date (mock data lives in October 2026). */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = projectToday || `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const confirmLabel: Record<Interpretation["kind"], string> = {
  order: "Confirmar pedido",
  delivery: "Confirmar entrega",
  payment: "Confirmar pago",
};

const followUp: Record<Interpretation["kind"], string> = {
  order: "Listo. Cuando llegue el material, escríbeme algo como «llegaron las 20 barras del 12» o envíame la foto del remito.",
  delivery: "Listo, la entrega quedó registrada. El estado de pago no cambió.",
  payment: "Listo, el pago quedó registrado y el saldo del proveedor ya está actualizado.",
};

function mapBlocks(messages: ChatMessage[], fn: (block: AssistantBlock) => AssistantBlock): ChatMessage[] {
  return messages.map((m) => (m.blocks ? { ...m, blocks: m.blocks.map(fn) } : m));
}

function findInterpretation(messages: ChatMessage[], blockId: string): InterpretationBlock | undefined {
  for (const m of messages) {
    for (const b of m.blocks ?? []) if (b.type === "interpretation" && b.id === blockId) return b;
  }
  return undefined;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { assistant } = useServices();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [today, setToday] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    let alive = true;
    assistant.initialThread().then(({ today: date, messages: thread }) => {
      if (!alive) return;
      projectToday = date;
      setToday(date);
      setMessages(thread);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [assistant]);

  const append = useCallback((...items: ChatMessage[]) => setMessages((prev) => [...prev, ...items]), []);

  const runAssistant = useCallback(
    async (produce: (onProgress: (title: string, steps: Extract<AssistantBlock, { type: "analysis" }>["steps"]) => void) => Promise<AssistantBlock[]>, analyzing: boolean) => {
      const replyId = uid("m");
      append({ id: replyId, role: "assistant", at: stamp(), blocks: [], status: analyzing ? "Asistente · analizando" : "Asistente · escribiendo" });
      setBusy(true);
      try {
        const blocks = await produce((title, steps) => {
          setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, blocks: [{ type: "analysis", title, steps }] } : m)));
        });
        setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, blocks, status: undefined } : m)));
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.id === replyId ? { ...m, status: undefined, blocks: [{ type: "text", text: "No pude procesar el mensaje. No se guardó nada; intenta de nuevo en un momento." }] } : m)),
        );
      } finally {
        setBusy(false);
        invalidate();
      }
    },
    [append, invalidate],
  );

  const send = useCallback(
    async (input: AssistantInput) => {
      const text = input.text?.trim();
      if (!text && !input.attachments?.length) return;
      append({ id: uid("m"), role: "user", at: stamp(), text, attachments: input.attachments });
      await runAssistant((onProgress) => assistant.respond({ text, attachments: input.attachments }, { onProgress }), Boolean(input.attachments?.length));
    },
    [append, assistant, runAssistant],
  );

  const updateInterpretation = useCallback((blockId: string, interpretation: Interpretation) => {
    setMessages((prev) => mapBlocks(prev, (b) => (b.type === "interpretation" && b.id === blockId ? { ...b, interpretation } : b)));
  }, []);

  const setBlockState = (blockId: string, patch: Partial<InterpretationBlock>) =>
    setMessages((prev) => mapBlocks(prev, (b) => (b.type === "interpretation" && b.id === blockId ? { ...b, ...patch } : b)));

  const confirm = useCallback(
    async (blockId: string) => {
      const block = findInterpretation(messagesRef.current, blockId);
      if (!block || block.state !== "pending") return;
      setBlockState(blockId, { state: "confirming" });
      try {
        const result = await assistant.confirm(blockId, block.interpretation);
        setBlockState(blockId, { state: "confirmed", result });
        append(
          { id: uid("m"), role: "user", at: stamp(), text: confirmLabel[block.interpretation.kind] },
          {
            id: uid("m"),
            role: "assistant",
            at: stamp(),
            blocks: [
              { type: "interpretation", id: `${blockId}-result`, interpretation: block.interpretation, state: "confirmed", result },
              { type: "text", text: followUp[block.interpretation.kind] },
            ],
          },
        );
        invalidate();
      } catch {
        setBlockState(blockId, { state: "pending" });
        toast("No se pudo guardar. Intenta de nuevo.", "info");
      }
    },
    [append, assistant, invalidate, toast],
  );

  const cancel = useCallback(
    async (blockId: string) => {
      setBlockState(blockId, { state: "cancelled" });
      await assistant.cancel(blockId);
      invalidate();
    },
    [assistant, invalidate],
  );

  const undo = useCallback(
    async (recordId: string) => {
      await assistant.undo(recordId);
      setMessages((prev) =>
        mapBlocks(prev, (b) => (b.type === "interpretation" && b.result?.recordId === recordId ? { ...b, state: "cancelled", result: undefined } : b)),
      );
      append({ id: uid("m"), role: "assistant", at: stamp(), blocks: [{ type: "text", text: "Deshice el registro. No quedó nada guardado." }] });
      invalidate();
      toast("Registro deshecho", "info");
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
      if (!choice || choice.resolved) return;
      const option = choice.options.find((o) => o.id === choice!.selected);
      setMessages((prev) => mapBlocks(prev, (b) => (b.type === "choice" && b.id === choiceId ? { ...b, resolved: true } : b)));
      append({ id: uid("m"), role: "user", at: stamp(), text: option?.title ?? "Continuar" });
      const ctx = choice.context;
      const selected = choice.selected;
      await runAssistant(() => assistant.resolveChoice(choiceId, selected, ctx), false);
    },
    [append, assistant, runAssistant],
  );

  const pendingCount = useMemo(
    () => messages.reduce((n, m) => n + (m.blocks ?? []).filter((b) => b.type === "interpretation" && (b.state === "pending" || b.state === "confirming") && !b.id.endsWith("-result")).length, 0),
    [messages],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({ messages, today, ready, busy, pendingCount, send, updateInterpretation, confirm, cancel, undo, chooseOption, continueChoice, draft, setDraft }),
    [messages, today, ready, busy, pendingCount, send, updateInterpretation, confirm, cancel, undo, chooseOption, continueChoice, draft],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
}

export function fileToAttachment(file: File): Attachment {
  const kb = file.size / 1024;
  const sizeLabel = kb > 1024 ? `${(kb / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(kb))} KB`;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  return {
    id: uid("att"),
    fileName: file.name,
    format: isPdf ? "pdf" : "image",
    sizeLabel,
    previewUrl: isPdf ? undefined : URL.createObjectURL(file),
  };
}

/** Simulated capture used by demo shortcuts when no real file is picked. */
export function sampleAttachment(fileName: string): Attachment {
  return { id: uid("att"), fileName, format: fileName.endsWith(".pdf") ? "pdf" : "image", sizeLabel: "1,2 MB" };
}
