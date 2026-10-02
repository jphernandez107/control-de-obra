import type { LucideIcon } from "lucide-react";
import { CircleCheck, Coins, FileX, Gauge, PackageCheck, Sparkles, Target, TriangleAlert, Truck, Wallet } from "lucide-react";
import type { DeliveryStatus, PaymentStatus, StatusTag } from "@/domain/types";
import { cn } from "./cn";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "ai" | "accent" | "outline";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-2",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  ai: "bg-ai-soft text-ai",
  accent: "bg-accent-soft text-accent",
  outline: "border border-border-strong text-fg-3",
};

export const tagMeta: Record<StatusTag, { label: string; icon: LucideIcon; tone: Tone }> = {
  entrega_pendiente: { label: "Pendiente de entrega", icon: Truck, tone: "neutral" },
  entrega_parcial: { label: "Entrega parcial", icon: Truck, tone: "info" },
  entregado: { label: "Entregado", icon: PackageCheck, tone: "success" },
  sin_pagos: { label: "Sin pagos", icon: Wallet, tone: "neutral" },
  pago_parcial: { label: "Pago parcial", icon: Wallet, tone: "warning" },
  pagado: { label: "Pagado", icon: CircleCheck, tone: "success" },
  pago_sin_imputar: { label: "Pago sin imputar", icon: Coins, tone: "ai" },
  sin_comprobante: { label: "Sin comprobante", icon: FileX, tone: "outline" },
  computo_cerca: { label: "Cerca del cómputo", icon: Gauge, tone: "warning" },
  computo_supera: { label: "Supera el cómputo", icon: TriangleAlert, tone: "danger" },
  computo_alcanzado: { label: "Cómputo alcanzado", icon: Target, tone: "accent" },
  por_confirmar: { label: "Por confirmar", icon: Sparkles, tone: "ai" },
};

export const deliveryTag: Record<DeliveryStatus, StatusTag> = {
  pendiente: "entrega_pendiente",
  parcial: "entrega_parcial",
  entregado: "entregado",
};

export const paymentTag: Record<PaymentStatus, StatusTag> = {
  sin_pagos: "sin_pagos",
  parcial: "pago_parcial",
  pagado: "pagado",
};

export function Pill({ tag, label, className }: { tag: StatusTag; label?: string; className?: string }) {
  const meta = tagMeta[tag];
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-[5px] rounded-xl px-[9px] text-xs font-medium whitespace-nowrap", tones[meta.tone], className)}>
      <Icon size={13} strokeWidth={2} />
      {label ?? meta.label}
    </span>
  );
}

export function Badge({ children, tone = "ai" }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={cn("inline-flex h-5 items-center rounded-[10px] px-[7px] font-mono text-[11px] font-medium", tones[tone])}>{children}</span>;
}
