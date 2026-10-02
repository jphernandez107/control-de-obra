import type { LucideIcon } from "lucide-react";
import { ArrowRight, Calculator, ClipboardList, Coins, FilePlus, Link as LinkIcon, PencilLine, Truck, Wallet } from "lucide-react";
import type { ActivityEvent, ActivityKind } from "@/domain/types";
import { Pill } from "../ui/Pill";
import { cn } from "../ui/cn";

export const activityMeta: Record<ActivityKind, { label: string; icon: LucideIcon; tile: string }> = {
  pedido_registrado: { label: "Pedido registrado", icon: ClipboardList, tile: "bg-surface-2 text-fg-2" },
  documento_agregado: { label: "Documento agregado", icon: FilePlus, tile: "bg-surface-2 text-fg-2" },
  entrega_registrada: { label: "Entrega registrada", icon: Truck, tile: "bg-info-soft text-info" },
  pago_registrado: { label: "Pago registrado", icon: Wallet, tile: "bg-success-soft text-success" },
  pago_imputado: { label: "Pago imputado", icon: LinkIcon, tile: "bg-ai-soft text-ai" },
  registro_corregido: { label: "Registro corregido", icon: PencilLine, tile: "bg-warning-soft text-warning" },
  computo_actualizado: { label: "Cómputo actualizado", icon: Calculator, tile: "bg-accent-soft text-accent" },
};

export function ActivityIcon({ event, size = 28 }: { event: Pick<ActivityEvent, "kind" | "tags">; size?: 24 | 28 | 30 }) {
  const unallocated = event.kind === "pago_registrado" && event.tags?.includes("pago_sin_imputar");
  const meta = activityMeta[event.kind];
  const Icon = unallocated ? Coins : meta.icon;
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-full", unallocated ? "bg-ai-soft text-ai" : meta.tile)}
      style={{ width: size, height: size }}
    >
      <Icon size={size === 24 ? 12 : 14} />
    </span>
  );
}

export function ChangeList({ event, compact }: { event: ActivityEvent; compact?: boolean }) {
  if (!event.changes?.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-3">
      {event.changes.map((c) => (
        <div key={c.label} className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-3">{compact ? c.label.replace(/^Barras /, "").replace(/ x 12 m$/, "") : c.label}</span>
          <span className="rounded-[5px] bg-surface-2 px-[7px] py-0.5 font-mono text-xs text-fg-3">{c.before}</span>
          <ArrowRight size={12} className="text-fg-3" />
          <span className="rounded-[5px] bg-accent-soft px-[7px] py-0.5 font-mono text-xs font-semibold text-accent">{c.after}</span>
        </div>
      ))}
      {event.reason && !compact ? <p className="text-xs text-fg-2">Motivo: {event.reason}</p> : null}
    </div>
  );
}

/** Timeline row: icon on a rail, title/time, description and optional details. */
export function ActivityItem({
  event,
  time,
  last,
  detailed = true,
  compact,
  onClick,
}: {
  event: ActivityEvent;
  time: string;
  last?: boolean;
  detailed?: boolean;
  compact?: boolean;
  onClick?: () => void;
}) {
  const description = compact && event.shortDescription ? event.shortDescription : event.description;
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper type={onClick ? "button" : undefined} onClick={onClick} className={cn("flex w-full gap-3 text-left", onClick && "group")}>
      <span className="flex flex-col items-center gap-1">
        <ActivityIcon event={event} />
        {!last ? <span className="w-px flex-1 bg-border" /> : null}
      </span>
      <span className={cn("flex min-w-0 flex-1 flex-col gap-[3px] pt-1", last ? "pb-1" : "pb-5")}>
        <span className="flex items-center gap-2">
          <span className="flex-1 text-sm font-medium text-fg group-hover:underline">{event.title}</span>
          <span className="font-mono text-xs text-fg-3">{time}</span>
        </span>
        <span className="text-[13px] text-fg-2">{description}</span>
        {detailed && (event.changes?.length || event.tags?.length) ? (
          <span className="mt-[5px] flex flex-col gap-2">
            <ChangeList event={event} compact={compact} />
            {event.tags?.length ? (
              <span className="flex flex-wrap gap-1.5">
                {event.tags.map((t) => (
                  <Pill key={t} tag={t} />
                ))}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </Wrapper>
  );
}
