import { Link, useNavigate } from "@tanstack/react-router";
import { CircleCheck } from "lucide-react";
import { formatMoney, formatRelativeStamp } from "@/domain/format";
import { ActivityItem } from "@/components/domain/ActivityItem";
import { AttentionRow } from "@/components/domain/AttentionRow";
import { Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useDashboard } from "@/queries";

const FIRST_STEPS = [
  { title: "Registra el primer pedido", sub: "Escribe o adjunta el comprobante. El proveedor se crea solo." },
  { title: "Registra entregas y pagos a medida que ocurren", sub: "Son independientes: un pedido puede estar entregado y sin pagar." },
  { title: "Carga el cómputo cuando lo tengas", sub: "Es opcional. Todo lo registrado antes se podrá comparar después." },
];

export function ContextPanel({ today, onShowPending }: { today: string; onShowPending: () => void }) {
  const { data, isPending } = useDashboard();
  const navigate = useNavigate();

  if (isPending || !data) {
    return (
      <aside className="hidden w-[360px] shrink-0 flex-col gap-6 border-l border-border bg-bg p-6 xl:flex">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-48" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </aside>
    );
  }

  if (!data.hasData) {
    return (
      <aside className="hidden w-[360px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-bg p-6 xl:flex">
        <h2 className="text-sm font-semibold text-fg">Primeros pasos</h2>
        {FIRST_STEPS.map((s, i) => (
          <div key={s.title} className="flex gap-3">
            <span className={cn("flex size-[26px] shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold", i === 0 ? "bg-accent text-on-accent" : "bg-surface-2 text-fg-2")}>
              {i + 1}
            </span>
            <div className="flex flex-col gap-[3px] pt-[3px]">
              <span className="text-sm font-medium text-fg">{s.title}</span>
              <span className="text-[13px] leading-[19px] text-fg-3">{s.sub}</span>
            </div>
          </div>
        ))}
        <span className="h-px w-full bg-border" />
        <div className="flex flex-col gap-1.5 rounded-[10px] bg-sunken p-4">
          <span className="flex items-center gap-2 text-sm font-medium text-fg">
            <CircleCheck size={16} className="text-fg-3" />
            Nada requiere atención
          </span>
          <span className="text-[13px] leading-[19px] text-fg-3">Aquí verás entregas parciales, saldos pendientes y registros por confirmar.</span>
        </div>
      </aside>
    );
  }

  const visible = data.attention.slice(0, 5);
  return (
    <aside className="hidden w-[360px] shrink-0 flex-col gap-7 overflow-y-auto border-l border-border bg-bg p-5 xl:flex">
      <div className="flex flex-col gap-1.5 px-1 pt-1">
        <span className="text-[13px] text-fg-3">Saldo total con proveedores</span>
        <span className="font-mono text-[30px] font-semibold tracking-[-1px] text-fg">{formatMoney(data.totalBalance)}</span>
        <span className="text-xs text-fg-3">
          {data.suppliersWithBalance} {data.suppliersWithBalance === 1 ? "proveedor" : "proveedores"} con saldo
          {data.unallocatedTotal > 0 ? ` · incluye ${formatMoney(data.unallocatedTotal)} sin imputar` : ""}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center px-1 pb-1.5">
          <h2 className="flex-1 text-sm font-semibold text-fg">Requiere atención</h2>
          <span className="font-mono text-xs text-fg-3">{data.attention.length}</span>
        </div>
        {visible.length === 0 ? (
          <p className="px-1 py-3 text-[13px] text-fg-3">Nada requiere atención por ahora.</p>
        ) : (
          visible.map((item) => <AttentionRow key={item.id} item={item} onSelect={item.kind === "por_confirmar" ? onShowPending : undefined} />)
        )}
        {data.attention.length > visible.length ? (
          <Link to="/atencion" className="px-1 pt-1 text-[13px] font-medium text-accent">
            Ver {data.attention.length - visible.length} más
          </Link>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex items-center px-1">
          <h2 className="flex-1 text-sm font-semibold text-fg">Actividad reciente</h2>
          <Link to="/actividad" className="text-[13px] font-medium text-accent">
            Ver todo
          </Link>
        </div>
        <div className="flex flex-col px-1">
          {data.recentActivity.map((e) => (
            <ActivityItem
              key={e.id}
              event={e}
              compact
              detailed={false}
              time={formatRelativeStamp(e.at, today)}
              onClick={e.orderId ? () => navigate({ to: "/pedidos/$orderId", params: { orderId: e.orderId! } }) : undefined}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
