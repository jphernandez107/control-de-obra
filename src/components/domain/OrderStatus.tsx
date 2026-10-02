import { CircleCheck, PackageCheck, Truck, Wallet } from "lucide-react";
import type { OrderSummary } from "@/domain/types";
import { formatMoney, formatNumber } from "@/domain/format";
import { Progress, type ProgressTone } from "../ui/Progress";
import { cn } from "../ui/cn";

function deliveryVisual(o: OrderSummary) {
  const d = o.delivery;
  const pct = d.ordered ? (d.delivered / d.ordered) * 100 : 0;
  if (d.status === "entregado") return { icon: PackageCheck, color: "text-success", tone: "success" as ProgressTone, label: "Entregado", short: "Entregado", pct };
  if (d.status === "parcial")
    return { icon: Truck, color: "text-info", tone: "info" as ProgressTone, label: "Entrega parcial", short: `Parcial ${formatNumber(d.delivered)}/${formatNumber(d.ordered)}`, pct };
  return { icon: Truck, color: "text-fg-2", tone: "neutral" as ProgressTone, label: "Pendiente", short: "Pendiente", pct: 0 };
}

function paymentVisual(o: OrderSummary) {
  const p = o.payment;
  if (p.status === "pagado") return { icon: CircleCheck, color: "text-success", tone: "success" as ProgressTone, label: "Pagado", short: "Pagado", pct: 100 };
  if (p.status === "parcial")
    return { icon: Wallet, color: "text-warning", tone: "warning" as ProgressTone, label: "Pago parcial", short: p.percent !== null ? `Parcial ${p.percent}%` : "Parcial", pct: p.percent ?? 0 };
  return { icon: Wallet, color: "text-fg-2", tone: "neutral" as ProgressTone, label: "Sin pagos", short: "Sin pagos", pct: 0 };
}

export function DeliveryCell({ order }: { order: OrderSummary }) {
  const v = deliveryVisual(order);
  const d = order.delivery;
  const detail =
    d.status === "entregado" ? (order.itemsLabel.includes("materiales") ? "Completo" : `${formatNumber(d.delivered)}/${formatNumber(d.ordered)} u`) : `${formatNumber(d.delivered)} de ${formatNumber(d.ordered)} u`;
  return (
    <StatusCell icon={<v.icon size={14} className={v.color} />} label={v.label} color={v.color} pct={v.pct} tone={v.tone} detail={detail} />
  );
}

export function PaymentCell({ order }: { order: OrderSummary }) {
  const v = paymentVisual(order);
  const p = order.payment;
  const detail =
    p.status === "pagado" ? "Completo" : p.status === "parcial" ? `${p.percent ?? "—"}% · ${formatMoney(p.paid)}` : order.total === null ? "Importe a confirmar" : "$0 pagado";
  return <StatusCell icon={<v.icon size={14} className={v.color} />} label={v.label} color={v.color} pct={v.pct} tone={v.tone} detail={detail} />;
}

function StatusCell({ icon, label, color, pct, tone, detail }: { icon: React.ReactNode; label: string; color: string; pct: number; tone: ProgressTone; detail: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        {icon}
        <span className={cn("text-[13px] font-medium", color)}>{label}</span>
      </span>
      <span className="flex items-center gap-2">
        <Progress value={pct} tone={pct === 0 ? "neutral" : tone} height={4} className="w-16 shrink-0" />
        <span className="font-mono text-[11px] whitespace-nowrap text-fg-3">{detail}</span>
      </span>
    </div>
  );
}

export function MiniStatuses({ order }: { order: OrderSummary }) {
  return (
    <div className="flex gap-3">
      {[deliveryVisual(order), paymentVisual(order)].map((v, i) => {
        const color = v.pct === 0 && v.color === "text-fg-2" ? "text-fg-3" : v.color;
        return (
          <span key={i} className="flex flex-1 items-center gap-1.5">
            <v.icon size={14} className={color} />
            <span className={cn("text-xs font-medium whitespace-nowrap", color)}>{v.short}</span>
            <Progress value={v.pct} tone={v.tone} height={4} className="w-11 shrink-0" />
          </span>
        );
      })}
    </div>
  );
}
