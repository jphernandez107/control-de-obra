import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, CircleCheck, Paperclip, Undo2, X } from "lucide-react";
import type { ConfirmResult, Interpretation } from "@/domain/assistant";
import type { StatusTag } from "@/domain/types";
import { formatMoney } from "@/domain/format";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { useState } from "react";

const DELIVERY_TAGS: StatusTag[] = ["entrega_pendiente", "entrega_parcial", "entregado"];

/** Card shown after confirming: what was saved, with "Ver" and "Deshacer". */
export function ConfirmedCard({ result, interpretation, onUndo }: { result: ConfirmResult; interpretation: Interpretation; onUndo: () => Promise<void> }) {
  const [undoing, setUndoing] = useState(false);
  const delivery = result.tags.find((t) => DELIVERY_TAGS.includes(t));
  const payment = result.tags.find((t) => !DELIVERY_TAGS.includes(t));
  const linkLabel = result.link.to === "/pedidos/$orderId" ? "Ver pedido" : "Ver cuenta corriente";
  return (
    <section className="w-full animate-pop-in overflow-hidden rounded-[14px] border border-border bg-surface">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
          <Check size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <h3 className="text-base font-semibold text-fg">{result.title}</h3>
          <p className="truncate text-[13px] text-fg-3">{result.subtitle}</p>
        </div>
      </header>
      <div className="flex flex-col gap-3 p-4">
        {interpretation.kind === "order" ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-fg-3">Total del pedido</span>
            <span className="font-mono text-2xl font-semibold tracking-[-0.5px] text-fg">{result.total !== undefined ? formatMoney(result.total) : "A confirmar"}</span>
          </div>
        ) : interpretation.kind === "payment" ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-fg-3">Importe</span>
            <span className="font-mono text-2xl font-semibold tracking-[-0.5px] text-fg">{formatMoney(interpretation.amount)}</span>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          {delivery ? (
            <div className="flex items-center">
              <span className="flex-1 text-[13px] text-fg-3">Entrega</span>
              <Pill tag={delivery} />
            </div>
          ) : null}
          {payment ? (
            <div className="flex items-center">
              <span className="flex-1 text-[13px] text-fg-3">Pago</span>
              <Pill tag={payment} />
            </div>
          ) : null}
        </div>
        {result.documentName ? (
          <p className="flex items-center gap-2 text-[13px] text-fg-2">
            <Paperclip size={14} className="text-fg-3" />
            {result.documentName} adjunto
          </p>
        ) : null}
      </div>
      <div className="flex gap-2 px-4 pb-4">
        <Link
          {...result.link}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] border border-border-strong bg-surface text-[15px] font-medium text-fg hover:bg-sunken"
        >
          <ArrowUpRight size={18} />
          {linkLabel}
        </Link>
        <Button
          variant="ghost"
          icon={Undo2}
          loading={undoing}
          onClick={async () => {
            setUndoing(true);
            await onUndo();
          }}
        >
          Deshacer
        </Button>
      </div>
    </section>
  );
}

/** Compact line that replaces an interpretation card once it is resolved. */
export function ResolvedRow({ state, result, label }: { state: "confirmed" | "cancelled"; result?: ConfirmResult; label: string }) {
  if (state === "confirmed" && result) {
    return (
      <div className="flex w-full items-center gap-2.5 rounded-[10px] border border-border px-3.5 py-2.5">
        <CircleCheck size={16} className="shrink-0 text-success" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
          {label} · <span className="font-normal text-fg-3">confirmado</span>
        </span>
        <Link {...result.link} className="text-[13px] font-medium text-accent">
          Ver
        </Link>
      </div>
    );
  }
  return (
    <div className="flex w-full items-center gap-2.5 rounded-[10px] border border-dashed border-border-strong px-3.5 py-2.5">
      <X size={16} className="shrink-0 text-fg-3" />
      <span className="text-[13px] text-fg-3">{label} · cancelado, no se guardó nada</span>
    </div>
  );
}

export function SavedRecord({ title, subtitle, tag, link }: { title: string; subtitle: string; tag?: StatusTag; link?: ConfirmResult["link"] }) {
  return (
    <div className="flex w-full flex-wrap items-center gap-2.5 rounded-[10px] border border-border px-3.5 py-2.5">
      <CircleCheck size={16} className="shrink-0 text-success" />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[13px] font-medium text-fg">{title}</span>
        <span className="font-mono text-xs text-fg-3">{subtitle}</span>
      </span>
      {tag ? <Pill tag={tag} /> : null}
      {link ? (
        <Link {...link} className="text-[13px] font-medium text-accent">
          Ver
        </Link>
      ) : null}
    </div>
  );
}
