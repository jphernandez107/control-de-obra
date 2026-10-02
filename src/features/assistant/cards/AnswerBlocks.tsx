import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Boxes, Camera, Check, ChevronRight, Circle, CircleAlert, CircleCheck, ClipboardList, GitFork, Keyboard, Loader, LoaderCircle, RotateCw, ScanEye, Store, Truck, Upload } from "lucide-react";
import type { AnalysisStep, BalanceRow, ChoiceOption, QuantityRow, SuggestedAction } from "@/domain/assistant";
import { formatMoney, formatNumber } from "@/domain/format";
import { Button } from "@/components/ui/Button";
import { SplitProgress } from "@/components/ui/Progress";
import { cn } from "@/components/ui/cn";
import { useUploadComputation } from "@/queries";
import { useToast } from "@/components/ui/Toast";

export function AnalysisCard({ title, steps }: { title: string; steps: AnalysisStep[] }) {
  return (
    <div className="flex w-full flex-col gap-3.5 rounded-[14px] border border-border bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-5 items-center justify-center">
          <Circle size={20} className="absolute text-ai-soft" strokeWidth={3} />
          <LoaderCircle size={20} className="absolute animate-spin text-ai" strokeWidth={2.5} />
        </span>
        <span className="text-[15px] font-semibold text-fg">{title}</span>
      </div>
      {steps.map((s) => (
        <div key={s.label} className="flex items-center gap-2.5">
          {s.state === "done" ? (
            <CircleCheck size={16} className="text-success" />
          ) : s.state === "active" ? (
            <Loader size={16} className="animate-spin-slow text-ai" />
          ) : (
            <Circle size={16} className="text-border-strong" />
          )}
          <span className={cn("flex-1 text-sm", s.state === "todo" ? "text-fg-3" : "text-fg-2")}>{s.label}</span>
        </div>
      ))}
      <div className="flex flex-col gap-2 pt-1">
        <span className="h-2.5 w-[86%] animate-shimmer rounded-[5px] bg-surface-2" />
        <span className="h-2.5 w-[68%] animate-shimmer rounded-[5px] bg-surface-2" />
        <span className="h-2.5 w-[77%] animate-shimmer rounded-[5px] bg-surface-2" />
      </div>
    </div>
  );
}

export function ChoiceBlock({
  options,
  selected,
  warning,
  resolved,
  onSelect,
  onContinue,
}: {
  options: ChoiceOption[];
  selected: string;
  warning?: string;
  resolved?: boolean;
  onSelect: (id: string) => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2.5">
      <div className="flex flex-col gap-2" role="radiogroup">
        {options.map((o) => {
          const active = o.id === selected;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={resolved}
              onClick={() => onSelect(o.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors",
                active ? "bg-accent-soft outline-[1.5px] -outline-offset-1 outline-accent" : "border border-border bg-surface hover:bg-sunken",
                resolved && !active && "opacity-50",
              )}
            >
              <span className={cn("size-5 shrink-0 rounded-full bg-surface", active ? "border-[6px] border-accent" : "border-[1.5px] border-border-strong")} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-medium text-fg">{o.title}</span>
                <span className="text-[13px] leading-[18px] text-fg-3">{o.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      {warning ? (
        <div className="flex items-center gap-2 rounded-[10px] bg-warning-soft px-3 py-2.5">
          <CircleAlert size={16} className="shrink-0 text-warning" />
          <span className="flex-1 text-[13px] leading-[18px] text-warning">{warning}</span>
        </div>
      ) : null}
      {!resolved ? (
        <Button icon={ArrowRight} size="lg" className="w-full lg:w-auto lg:self-start" onClick={onContinue}>
          Continuar
        </Button>
      ) : null}
    </div>
  );
}

export function ReadErrorCard({ onRetake, onManual, onRetry }: { onRetake: () => void; onManual: () => void; onRetry: () => void }) {
  return (
    <div className="flex w-full flex-col gap-3 rounded-[14px] border border-border-strong bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-[9px] bg-danger-soft text-danger">
          <ScanEye size={17} />
        </span>
        <h3 className="text-base font-semibold text-fg">No pude leer el comprobante</h3>
      </div>
      <p className="text-sm leading-[21px] text-fg-2">La foto está borrosa y no distingo los importes ni las cantidades. No se registró nada.</p>
      <ul className="flex flex-col gap-1.5 rounded-[10px] bg-sunken p-3">
        {["Apoya el papel sobre una superficie plana", "Evita sombras y reflejos", "Que se vea el comprobante completo"].map((tip) => (
          <li key={tip} className="flex items-center gap-2 text-[13px] text-fg-2">
            <Check size={14} className="text-fg-3" />
            {tip}
          </li>
        ))}
      </ul>
      <Button icon={Camera} size="lg" className="w-full" onClick={onRetake}>
        Tomar otra foto
      </Button>
      <div className="flex gap-2">
        <Button variant="secondary" icon={Keyboard} className="flex-1" onClick={onManual}>
          Cargar a mano
        </Button>
        <Button variant="ghost" icon={RotateCw} onClick={onRetry}>
          Reintentar
        </Button>
      </div>
    </div>
  );
}

export function BalanceBlock({ ordered, paid, balance, allocatedPaid, unallocatedPaid, rows }: { ordered: number; paid: number; balance: number; allocatedPaid: number; unallocatedPaid: number; rows: BalanceRow[] }) {
  const navigate = useNavigate();
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex gap-2 p-3.5">
        <Total label="Pedidos" value={formatMoney(ordered)} />
        <Total label="Pagado" value={formatMoney(paid)} className="text-success" />
        <Total label="Saldo" value={formatMoney(balance)} large />
      </div>
      <div className="px-3.5 pb-3">
        <SplitProgress
          height={8}
          segments={[
            { value: ordered ? (allocatedPaid / ordered) * 100 : 0, tone: "success" },
            { value: ordered ? (unallocatedPaid / ordered) * 100 : 0, tone: "ai" },
          ]}
        />
      </div>
      {rows.map((r) => (
        <button
          key={r.label + r.description}
          type="button"
          disabled={!r.orderId}
          onClick={() => r.orderId && navigate({ to: "/pedidos/$orderId", params: { orderId: r.orderId } })}
          className="flex w-full items-center gap-2.5 border-t border-border px-3.5 py-2.5 text-left enabled:hover:bg-sunken"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className={cn("text-sm font-medium", r.unallocated ? "text-ai" : "text-fg")}>{r.label}</span>
            <span className="text-xs text-fg-3">{r.description}</span>
          </span>
          <span className={cn("font-mono text-sm font-medium", r.unallocated ? "text-ai" : "text-fg")}>{r.amount < 0 ? `−${formatMoney(-r.amount)}` : formatMoney(r.amount)}</span>
        </button>
      ))}
    </div>
  );
}

function Total({ label, value, className, large }: { label: string; value: string; className?: string; large?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-xs text-fg-3">{label}</span>
      <span className={cn("truncate font-mono font-semibold text-fg", large ? "text-base" : "text-sm", className)}>{value}</span>
    </div>
  );
}

export function QuantitiesBlock({ rows, computationPrompt }: { rows: QuantityRow[]; computationPrompt: boolean }) {
  const upload = useUploadComputation();
  const toast = useToast();
  return (
    <div className="flex w-full flex-col gap-2.5">
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex gap-2 bg-sunken px-3 py-2 text-xs font-medium text-fg-3">
          <span className="flex-1">Material</span>
          <span className="w-16 text-right">Pedido</span>
          <span className="w-[76px] text-right">Entregado</span>
        </div>
        {rows.map((r) => (
          <div key={r.material} className="flex items-center gap-2 border-t border-border px-3 py-2.5">
            <span className="flex-1 text-sm font-medium text-fg">{r.material}</span>
            <span className="w-16 text-right font-mono text-sm text-fg">
              {formatNumber(r.ordered)} {r.unit}
            </span>
            <span className={cn("w-[76px] text-right font-mono text-sm", r.delivered < r.ordered ? "text-info" : "text-fg")}>
              {formatNumber(r.delivered)} {r.unit}
            </span>
          </div>
        ))}
      </div>
      {computationPrompt ? (
        <div className="flex flex-col gap-2.5 rounded-xl bg-sunken p-3.5">
          <span className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Boxes size={16} className="text-fg-2" />
            Cuando cargues el cómputo
          </span>
          <p className="text-[13px] leading-[19px] text-fg-2">Compararé automáticamente todo lo registrado antes y te avisaré si un material se acerca o supera lo previsto.</p>
          <Button
            variant="secondary"
            icon={Upload}
            className="w-full"
            loading={upload.isPending}
            onClick={() => upload.mutate(undefined, { onSuccess: () => toast("Cómputo cargado: 10 materiales vinculados") })}
          >
            Cargar cómputo
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function PendingDeliveriesBlock({ rows }: { rows: { orderId: string; orderNumber: string; supplier: string; pendingLabel: string }[] }) {
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border bg-surface">
      {rows.map((r, i) => (
        <Link
          key={r.orderId}
          to="/pedidos/$orderId"
          params={{ orderId: r.orderId }}
          className={cn("flex items-center gap-3 px-3.5 py-3 hover:bg-sunken", i > 0 && "border-t border-border")}
        >
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-info-soft text-info">
            <Truck size={15} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium text-fg">
              Pedido {r.orderNumber} · {r.supplier}
            </span>
            <span className="text-[13px] text-fg-3">{r.pendingLabel}</span>
          </span>
          <ChevronRight size={16} className="text-fg-3" />
        </Link>
      ))}
    </div>
  );
}

const actionIcons = { "git-fork": GitFork, store: Store, upload: Upload, "clipboard-list": ClipboardList, truck: Truck };

export function ActionChips({ actions, onPrompt }: { actions: SuggestedAction[]; onPrompt: (prompt: string) => void }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => {
        const Icon = actionIcons[a.icon];
        return (
          <button
            key={a.label}
            type="button"
            onClick={() => (a.link ? navigate(a.link) : a.prompt && onPrompt(a.prompt))}
            className="inline-flex h-[34px] items-center gap-1.5 rounded-[17px] border border-border bg-surface px-3 text-[13px] text-fg-2 hover:bg-sunken"
          >
            <Icon size={14} className="text-fg-3" />
            {a.label}
          </button>
        );
      })}
    </div>
  );
}
