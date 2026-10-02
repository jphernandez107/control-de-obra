import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, CircleCheck, Coins, FileX, Gauge, PackageCheck, Sparkles, TriangleAlert, Truck } from "lucide-react";
import type { AttentionItem, AttentionKind } from "@/domain/types";
import { cn } from "../ui/cn";

export const attentionMeta: Record<AttentionKind, { icon: LucideIcon; tile: string; chip: string }> = {
  por_confirmar: { icon: Sparkles, tile: "bg-ai-soft text-ai", chip: "bg-ai-soft text-ai" },
  computo_supera: { icon: TriangleAlert, tile: "bg-danger-soft text-danger", chip: "bg-danger-soft text-danger" },
  computo_cerca: { icon: Gauge, tile: "bg-warning-soft text-warning", chip: "bg-warning-soft text-warning" },
  computo_alcanzado: { icon: CircleCheck, tile: "bg-surface-2 text-fg-2", chip: "bg-surface-2 text-fg-2" },
  entrega_parcial: { icon: Truck, tile: "bg-info-soft text-info", chip: "bg-info-soft text-info" },
  entregado_sin_pagos: { icon: PackageCheck, tile: "bg-warning-soft text-warning", chip: "bg-warning-soft text-warning" },
  pago_sin_imputar: { icon: Coins, tile: "bg-ai-soft text-ai", chip: "bg-surface-2 text-fg-2" },
  sin_comprobante: { icon: FileX, tile: "bg-surface-2 text-fg-2", chip: "bg-surface-2 text-fg-2" },
};

export function AttentionRow({ item, onSelect }: { item: AttentionItem; onSelect?: () => void }) {
  const meta = attentionMeta[item.kind];
  const content = (
    <>
      <span className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-lg", meta.tile)}>
        <meta.icon size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{item.title}</span>
        <span className="text-[13px] text-fg-3">{item.description}</span>
      </span>
      <ChevronRight size={16} className="mt-0.5 shrink-0 text-fg-3" />
    </>
  );
  const className = "flex w-full items-start gap-3 rounded-lg px-1 py-3 text-left transition-colors hover:bg-surface-2/60";
  if (onSelect || !item.link) {
    return (
      <button type="button" className={className} onClick={onSelect}>
        {content}
      </button>
    );
  }
  return (
    <Link {...item.link} className={className}>
      {content}
    </Link>
  );
}
