import { useCallback, useRef, useState } from "react";
import type { Attachment } from "@/domain/assistant";
import { useAssistant } from "./AssistantProvider";

export interface ComposerController {
  text: string;
  setText: (text: string) => void;
  attachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  canSend: boolean;
  submit: () => void;
  /** Puts text in the composer and focuses it, without sending. */
  prefill: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}

export function useComposer(): ComposerController {
  const { send, busy } = useAssistant();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const canSend = !busy && (text.trim().length > 0 || attachments.length > 0);

  const submit = useCallback(() => {
    if (!canSend) return;
    const payload = { text, attachments };
    setText("");
    setAttachments([]);
    void send(payload);
  }, [attachments, canSend, send, text]);

  const prefill = useCallback((value: string) => {
    setText(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    });
  }, []);

  return {
    text,
    setText,
    attachments,
    addAttachment: (a) => setAttachments([a]),
    removeAttachment: (id) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
    canSend,
    submit,
    prefill,
    inputRef,
  };
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

/** Browser dictation when available (Chrome/Safari); returns null otherwise. */
export function createDictation(onText: (text: string) => void, onEnd: () => void): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "es-AR";
  rec.interimResults = false;
  rec.onresult = (e) => {
    const transcript = Array.from(e.results)
      .map((r) => r[0]?.transcript ?? "")
      .join(" ");
    onText(transcript);
  };
  rec.onend = onEnd;
  rec.onerror = onEnd;
  return rec;
}
