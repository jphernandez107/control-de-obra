import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { ArrowUpLeft, Bell, Boxes, Camera, ClipboardPlus, MessagesSquare, Sparkles, Truck, Wallet } from "lucide-react";
import { formatWeekdayShort } from "@/domain/format";
import { attentionMeta } from "@/components/domain/AttentionRow";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { useDashboard, useSession } from "@/queries";
import { fileToAttachment, isSupportedAttachment, useAssistant } from "@/features/assistant/AssistantProvider";
import { AttachSheet } from "@/features/assistant/AttachSheet";
import { AiStatusNotice } from "@/features/assistant/cards/AnswerBlocks";
import { DESKTOP_SUGGESTIONS, DesktopComposer, MOBILE_SUGGESTIONS, MobileComposer, SuggestionChips, type Suggestion } from "@/features/assistant/Composer";
import { ContextPanel } from "@/features/assistant/ContextPanel";
import { ConversationsDrawer } from "@/features/assistant/ConversationsDrawer";
import { Thread, type ThreadActions } from "@/features/assistant/Thread";
import { useComposer } from "@/features/assistant/useComposer";

const EXAMPLES: { icon: LucideIcon; text: string; short: string; photo?: boolean }[] = [
  { icon: ClipboardPlus, text: "Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba.", short: "Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba." },
  { icon: Truck, text: "Llegaron las 20 barras del 12.", short: "Llegaron las 20 barras del 12" },
  { icon: Wallet, text: "Pagamos $500.000 de la cuenta corriente de Hierros Córdoba.", short: "Pagamos $500.000 de la cuenta corriente de Hierros Córdoba." },
  { icon: Camera, text: "Saca una foto del comprobante de pedido o del remito", short: "Saca una foto del comprobante", photo: true },
];

export function AssistantPage() {
  const desktop = useIsDesktop();
  const assistant = useAssistant();
  const composer = useComposer();
  const toast = useToast();
  const navigate = useNavigate();
  const dashboard = useDashboard();
  const session = useSession();
  const [attachOpen, setAttachOpen] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasMessages = assistant.messages.length > 0;
  const aiOff = session.data?.ai.configured === false;
  const today = assistant.today;
  const showSuggestions = assistant.pendingCount === 0 && !assistant.busy;

  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  useEffect(() => {
    scrollToBottom(assistant.messages.length > 4);
  }, [assistant.messages]);

  useEffect(() => {
    if (assistant.draft) {
      composer.prefill(assistant.draft);
      assistant.setDraft("");
    }
  }, [assistant.draft]);

  const pickSuggestion = (s: Suggestion) => {
    if (s.send) void assistant.send({ text: s.send });
    else if (s.prefill) composer.prefill(s.prefill);
  };

  const pickExample = (example: (typeof EXAMPLES)[number]) => {
    if (example.photo) {
      (desktop ? fileRef : cameraRef).current?.click();
    } else {
      composer.prefill(example.text);
    }
  };

  const attach = (file: File) => {
    if (!isSupportedAttachment(file)) {
      toast("Formato no soportado. Adjunta un PDF o una foto (JPG, PNG o HEIC).", "info");
      return;
    }
    composer.addAttachment(fileToAttachment(file));
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) attach(file);
    e.target.value = "";
  };

  const pasteWhatsApp = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) composer.prefill(text.trim());
      else throw new Error("empty");
    } catch {
      composer.prefill("");
      toast("Pega el mensaje copiado en el campo de texto", "info");
    }
  };

  const actions: ThreadActions = {
    onPrompt: (text) => void assistant.send({ text }),
    onRetakePhoto: () => cameraRef.current?.click(),
    onManualEntry: () => {
      composer.prefill("Llegaron ");
      toast("Escribe lo que dice el comprobante", "info");
    },
  };

  const hiddenInputs = (
    <>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
      <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onFile} />
    </>
  );

  const attention = dashboard.data?.attention ?? [];
  const chips = attention.filter((a, i, all) => a.chip && all.findIndex((b) => b.chip === a.chip) === i);

  if (desktop) {
    return (
      <div className="flex h-full min-h-0">
        <section
          className="flex min-w-0 flex-1 flex-col bg-surface"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) attach(file);
          }}
        >
          {!assistant.ready ? null : hasMessages ? (
            <>
              <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-8">
                <div className="flex min-w-0 flex-1 flex-col gap-px">
                  <h1 className="text-base font-semibold text-fg">Asistente de obra</h1>
                  <p className="truncate text-[13px] text-fg-3">Escribe, dicta o adjunta comprobantes. Nada se guarda sin tu confirmación.</p>
                </div>
                <Button variant="ghost" size="sm" icon={MessagesSquare} onClick={() => setConversationsOpen(true)}>
                  Conversaciones
                </Button>
              </header>
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-4">
                <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-end">
                  <Thread messages={assistant.messages} today={today} actions={actions} />
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-center gap-2.5 px-10 pt-3 pb-6">
                <div className="flex w-full max-w-[720px] flex-col gap-2.5">
                  {!assistant.busy ? <SuggestionChips items={DESKTOP_SUGGESTIONS} onPick={pickSuggestion} /> : null}
                  <DesktopComposer composer={composer} />
                </div>
                {aiOff ? (
                  <div className="w-full max-w-[720px]">
                    <AiStatusNotice />
                  </div>
                ) : <p className="text-xs text-fg-3">Puedes arrastrar PDFs, fotos de remitos o capturas de transferencias.</p>}
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-10 pb-20">
              <div className="flex w-full max-w-[720px] flex-col gap-7">
                <div className="flex flex-col gap-2.5">
                  <span className="flex size-10 items-center justify-center rounded-[11px] bg-ai-soft text-ai">
                    <Sparkles size={20} />
                  </span>
                  <h1 className="text-[32px] leading-[38px] font-semibold tracking-[-0.8px] text-fg">{session.data ? `Hola, ${session.data.user.name.split(" ")[0]}. ` : ""}Cuéntame qué pasó en la obra.</h1>
                  <p className="text-base leading-6 text-fg-2">
                    Registro pedidos, entregas y pagos a partir de mensajes, fotos de remitos o capturas de transferencias. Siempre te muestro lo que entendí antes de guardar.
                  </p>
                  <div className="mt-[18px] flex flex-col gap-2.5">
                    {aiOff ? <AiStatusNotice /> : null}
                    <DesktopComposer composer={composer} />
                  </div>
                </div>
                <div className="flex flex-col">
                  <span className="pb-1 text-xs font-medium text-fg-3">Prueba con algo así</span>
                  {EXAMPLES.map((ex) => (
                    <button key={ex.text} type="button" onClick={() => pickExample(ex)} className="group flex items-center gap-3 border-b border-border px-1 py-3 text-left hover:bg-sunken">
                      <ex.icon size={16} className="shrink-0 text-fg-3" />
                      <span className="flex-1 text-[15px] text-fg-2 group-hover:text-fg">{ex.photo ? ex.text : `“${ex.text}”`}</span>
                      <ArrowUpLeft size={14} className="text-fg-3" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
        <ContextPanel today={today} onShowPending={() => scrollToBottom()} />
        <ConversationsDrawer open={conversationsOpen} onClose={() => setConversationsOpen(false)} />
        {hiddenInputs}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 pt-1 pr-3 pl-5">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-xs text-fg-3">Casa Córdoba{today ? ` · ${formatWeekdayShort(today)}` : ""}</span>
          <h1 className="text-xl font-semibold tracking-[-0.3px] text-fg">Asistente</h1>
        </div>
        {hasMessages ? (
          <button type="button" aria-label="Conversaciones" onClick={() => setConversationsOpen(true)} className="flex size-11 items-center justify-center rounded-[10px] text-fg-2">
            <MessagesSquare size={20} />
          </button>
        ) : null}
        <Link to="/atencion" aria-label="Requiere atención" className="relative flex size-11 items-center justify-center rounded-full border border-border bg-surface text-fg">
          <Bell size={20} />
          {attention.length ? <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-ai ring-2 ring-surface" /> : null}
        </Link>
      </header>
      {hasMessages && chips.length ? (
        <div className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto px-4 pt-1 pb-2.5">
          {chips.map((c) => {
            const meta = attentionMeta[c.kind];
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => (c.kind === "por_confirmar" ? scrollToBottom() : c.link ? navigate(c.link) : undefined)}
                className={cn("inline-flex h-8 shrink-0 items-center gap-[5px] rounded-2xl px-3 text-[13px] font-medium", meta.chip)}
              >
                <meta.icon size={14} />
                {c.chip}
              </button>
            );
          })}
        </div>
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4">
        {!assistant.ready ? null : hasMessages ? (
          <div className="flex min-h-full flex-col justify-end">
            <Thread
              messages={assistant.messages}
              today={today}
              actions={actions}
              footer={
                assistant.messages.at(-1)?.status === "Asistente · analizando" ? (
                  <p className="text-center text-xs text-fg-3">Puedes seguir escribiendo mientras tanto. No se guarda nada todavía.</p>
                ) : null
              }
            />
          </div>
        ) : (
          <div className="flex min-h-full flex-col justify-center gap-6 px-1 py-6">
            <div className="flex flex-col gap-3">
              <span className="flex size-10 items-center justify-center rounded-[11px] bg-ai-soft text-ai">
                <Sparkles size={20} />
              </span>
              <h2 className="text-[26px] leading-8 font-semibold tracking-[-0.5px] text-fg">Cuéntame qué pasó en la obra</h2>
              <p className="text-[15px] leading-6 text-fg-2">Escribe como en WhatsApp o saca una foto del comprobante. Revisarás todo antes de guardar.</p>
            </div>
            <div className="flex flex-col">
              {EXAMPLES.slice(0, 3).map((ex) => (
                <button key={ex.text} type="button" onClick={() => pickExample(ex)} className="flex min-h-12 items-center gap-3 border-b border-border py-3 text-left">
                  <ex.icon size={18} className="shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1 truncate text-[15px] text-fg-2">{ex.short}</span>
                  <ArrowUpLeft size={14} className="text-fg-3" />
                </button>
              ))}
            </div>
            {aiOff ? <AiStatusNotice /> : null}
            {dashboard.data && !dashboard.data.computation.loaded ? (
              <div className="flex items-start gap-2.5 rounded-[10px] bg-sunken px-3.5 py-3">
                <Boxes size={16} className="mt-0.5 shrink-0 text-fg-3" />
                <p className="text-[13px] leading-[19px] text-fg-3">Sin cómputo cargado. Puedes registrar igual y compararlo más adelante.</p>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <MobileComposer
        composer={composer}
        suggestions={showSuggestions ? MOBILE_SUGGESTIONS : undefined}
        onPickSuggestion={pickSuggestion}
        onOpenAttach={() => setAttachOpen(true)}
        cameraRef={cameraRef}
      />
      <AttachSheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onCamera={() => cameraRef.current?.click()}
        onGallery={() => galleryRef.current?.click()}
        onFile={() => fileRef.current?.click()}
        onPaste={pasteWhatsApp}
      />
      <ConversationsDrawer open={conversationsOpen} onClose={() => setConversationsOpen(false)} />
      {hiddenInputs}
    </div>
  );
}
