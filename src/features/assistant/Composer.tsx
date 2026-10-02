import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowUp, Camera, ClipboardPlus, FileText, Image as ImageIcon, Mic, Paperclip, Scale, Truck, Wallet, X } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { fileToAttachment, isSupportedAttachment } from "./AssistantProvider";
import { createDictation, type ComposerController } from "./useComposer";

export interface Suggestion {
  label: string;
  icon: LucideIcon;
  prefill?: string;
  send?: string;
}

export const DESKTOP_SUGGESTIONS: Suggestion[] = [
  { label: "Registrar entrega", icon: Truck, prefill: "Llegaron " },
  { label: "Registrar pago", icon: Wallet, prefill: "Pagamos " },
  { label: "Nuevo pedido", icon: ClipboardPlus, prefill: "Marcelo pidió " },
  { label: "¿Cuánto debemos?", icon: Scale, send: "¿Cuánto debemos a cada proveedor?" },
];

export const MOBILE_SUGGESTIONS: Suggestion[] = [
  { label: "Llegó material", icon: Truck, prefill: "Llegaron " },
  { label: "Registrar pago", icon: Wallet, prefill: "Pagamos " },
  { label: "¿Cuánto debemos?", icon: Scale, send: "¿Cuánto debemos a cada proveedor?" },
  { label: "Nuevo pedido", icon: ClipboardPlus, prefill: "Marcelo pidió " },
];

export function SuggestionChips({ items, onPick, className }: { items: Suggestion[]; onPick: (s: Suggestion) => void; className?: string }) {
  return (
    <div className={cn("no-scrollbar flex gap-2 overflow-x-auto", className)}>
      {items.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => onPick(s)}
          className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-[17px] border border-border bg-surface px-3 text-[13px] text-fg-2 hover:bg-sunken"
        >
          <s.icon size={14} className="text-fg-3" />
          {s.label}
        </button>
      ))}
    </div>
  );
}

function StagedAttachments({ composer }: { composer: ComposerController }) {
  if (!composer.attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {composer.attachments.map((a) => (
        <span key={a.id} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-sunken pr-1 pl-2.5 text-[13px] text-fg">
          {a.format === "pdf" ? <FileText size={14} className="text-danger" /> : <ImageIcon size={14} className="text-info" />}
          <span className="max-w-[200px] truncate">{a.fileName}</span>
          <button type="button" aria-label={`Quitar ${a.fileName}`} onClick={() => composer.removeAttachment(a.id)} className="flex size-7 items-center justify-center rounded text-fg-3 hover:text-fg">
            <X size={14} />
          </button>
        </span>
      ))}
    </div>
  );
}

function useDictation(composer: ComposerController) {
  const toast = useToast();
  const [listening, setListening] = useState(false);
  const recRef = useRef<ReturnType<typeof createDictation>>(null);
  const toggle = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = createDictation(
      (t) => composer.setText(`${composer.text}${composer.text ? " " : ""}${t}`.trim()),
      () => setListening(false),
    );
    if (!rec) {
      toast("El dictado no está disponible en este navegador", "info");
      return;
    }
    recRef.current = rec;
    setListening(true);
    rec.start();
  };
  return { listening, toggle };
}

function FileInputs({ onFile, cameraRef, fileRef }: { onFile: (f: File) => void; cameraRef: React.RefObject<HTMLInputElement | null>; fileRef: React.RefObject<HTMLInputElement | null> }) {
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = "";
  };
  return (
    <>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handle} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={handle} />
    </>
  );
}

export function DesktopComposer({ composer, onFocusChange }: { composer: ComposerController; onFocusChange?: (focused: boolean) => void }) {
  const toast = useToast();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { listening, toggle } = useDictation(composer);

  useEffect(() => {
    composer.inputRef.current = textRef.current;
  });

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [composer.text]);

  return (
    <div className="flex w-full flex-col gap-2.5 rounded-[14px] border border-border-strong bg-surface pt-3.5 pr-3.5 pb-2.5 pl-4 shadow-composer focus-within:border-accent">
      <StagedAttachments composer={composer} />
      <textarea
        ref={textRef}
        rows={1}
        value={composer.text}
        onChange={(e) => composer.setText(e.target.value)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            composer.submit();
          }
        }}
        placeholder="Cuéntame qué pasó en la obra o adjunta un comprobante…"
        aria-label="Mensaje para el asistente"
        className="max-h-40 min-h-[22px] w-full resize-none bg-transparent text-[15px] leading-[22px] text-fg outline-none"
      />
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[13px] font-medium text-fg-2 hover:text-fg">
          <Paperclip size={16} />
          Adjuntar
        </button>
        <button type="button" onClick={() => cameraRef.current?.click()} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[13px] font-medium text-fg-2 hover:text-fg">
          <Camera size={16} />
          Foto
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={toggle}
          aria-label={listening ? "Detener dictado" : "Dictar"}
          className={cn("flex size-9 items-center justify-center rounded-full", listening ? "animate-shimmer bg-danger-soft text-danger" : "text-fg-2 hover:bg-surface-2")}
        >
          <Mic size={18} />
        </button>
        <button
          type="button"
          onClick={composer.submit}
          disabled={!composer.canSend}
          aria-label="Enviar"
          className="flex size-9 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity hover:bg-accent-hover disabled:opacity-40"
        >
          <ArrowUp size={18} />
        </button>
      </div>
      <FileInputs onFile={(f) => (isSupportedAttachment(f) ? composer.addAttachment(fileToAttachment(f)) : toast("Formato no soportado. Adjunta un PDF o una foto.", "info"))} cameraRef={cameraRef} fileRef={fileRef} />
    </div>
  );
}

export function MobileComposer({
  composer,
  suggestions,
  onPickSuggestion,
  onOpenAttach,
  cameraRef,
}: {
  composer: ComposerController;
  suggestions?: Suggestion[];
  onPickSuggestion: (s: Suggestion) => void;
  onOpenAttach: () => void;
  cameraRef: React.RefObject<HTMLInputElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { listening, toggle } = useDictation(composer);
  const hasContent = composer.text.trim().length > 0 || composer.attachments.length > 0;

  useEffect(() => {
    composer.inputRef.current = inputRef.current;
  });

  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-t border-border bg-surface px-3 py-2.5 lg:hidden">
      {suggestions ? <SuggestionChips items={suggestions} onPick={onPickSuggestion} className="-mx-3 px-3" /> : null}
      <StagedAttachments composer={composer} />
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          composer.submit();
        }}
      >
        <button type="button" aria-label="Tomar foto" onClick={() => cameraRef.current?.click()} className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Camera size={22} />
        </button>
        <label className="flex h-12 min-w-0 flex-1 items-center gap-1 rounded-full border border-border bg-sunken pr-1.5 pl-3.5 focus-within:border-accent">
          <input
            ref={inputRef}
            value={composer.text}
            onChange={(e) => composer.setText(e.target.value)}
            placeholder={listening ? "Escuchando…" : "Escribe o dicta…"}
            aria-label="Mensaje para el asistente"
            enterKeyHint="send"
            className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none"
          />
          <button type="button" aria-label="Adjuntar comprobante" onClick={onOpenAttach} className="flex size-9 shrink-0 items-center justify-center rounded-full text-fg-2">
            <Paperclip size={20} />
          </button>
        </label>
        {hasContent ? (
          <button type="submit" aria-label="Enviar" disabled={!composer.canSend} className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent disabled:opacity-50">
            <ArrowUp size={22} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={listening ? "Detener dictado" : "Dictar"}
            onClick={toggle}
            className={cn("flex size-12 shrink-0 items-center justify-center rounded-full", listening ? "animate-shimmer bg-danger text-on-accent" : "bg-accent text-on-accent")}
          >
            <Mic size={22} />
          </button>
        )}
      </form>
    </div>
  );
}
