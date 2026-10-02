import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Check, CircleAlert, Info, Pencil, X } from "lucide-react";
import type { InterpretationValidation } from "@/domain/assistant";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/components/ui/cn";

export function CardShell({
  icon: Icon,
  title,
  subtitle,
  badge,
  children,
  actions,
  className,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  badge?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("w-full animate-pop-in overflow-hidden rounded-[14px] border border-border-strong bg-surface shadow-card", className)}>
      <header className="flex items-center gap-2.5 bg-ai-soft px-4 py-3.5 lg:px-5 lg:py-4">
        <Icon size={18} className="shrink-0 text-ai" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-base font-semibold text-fg">{title}</h3>
          <p className="text-[13px] text-fg-2">{subtitle}</p>
        </div>
        {badge ? <Pill tag="por_confirmar" className="hidden lg:inline-flex" /> : null}
      </header>
      {children}
      {actions}
    </section>
  );
}

export function CardActions({
  confirmLabel,
  onConfirm,
  onEdit,
  onCancel,
  confirming,
  editing,
  validation,
}: {
  confirmLabel: string;
  onConfirm: () => void;
  onEdit: () => void;
  onCancel: () => void;
  confirming?: boolean;
  editing?: boolean;
  /** Server validation: blocking problems are listed and disable confirmation until fixed. */
  validation?: InterpretationValidation;
}) {
  const errors = validation?.issues.filter((x) => x.severity === "error") ?? [];
  return (
    <>
      {errors.length ? (
        <div className="flex items-start gap-2 border-t border-border bg-danger-soft px-4 py-2.5 lg:px-5" role="alert">
          <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-[13px] leading-[18px] text-danger">Falta resolver antes de confirmar: {errors.map((x) => x.message).join(" ")}</p>
        </div>
      ) : null}
      <div className="flex items-center gap-2 border-t border-border px-4 pt-3 pb-4 lg:px-5 lg:pt-3.5 lg:pb-[18px]">
        <Button icon={Check} onClick={onConfirm} loading={confirming} disabled={errors.length > 0} className="h-12 flex-1 lg:h-11 lg:flex-none">
          {confirmLabel}
        </Button>
        <Button variant="secondary" icon={editing ? Check : Pencil} onClick={onEdit} disabled={confirming} className="h-12 lg:h-11">
          {editing ? "Listo" : "Editar"}
        </Button>
        <span className="hidden flex-1 lg:block" />
        <Button variant="ghost" icon={X} onClick={onCancel} disabled={confirming} className="hidden lg:inline-flex">
          Cancelar
        </Button>
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          aria-label="Cancelar"
          className="flex size-12 shrink-0 items-center justify-center rounded-[10px] border border-border bg-surface text-fg-2 lg:hidden"
        >
          <X size={18} />
        </button>
      </div>
    </>
  );
}

export function VerifyFlag({ variant = "text" }: { variant?: "text" | "pill" }) {
  if (variant === "pill") {
    return (
      <span className="inline-flex items-center gap-[3px] rounded-md bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning">
        <CircleAlert size={11} />
        Verificar
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-[3px] text-[11px] font-medium text-warning">
      <CircleAlert size={12} />
      Verificar
    </span>
  );
}

export function Outcome({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-[10px] bg-surface-2 px-3 py-2.5 lg:px-3.5 lg:py-3">
      <Info size={16} className="mt-px shrink-0 text-fg-2" />
      <p className="flex-1 text-[13px] leading-[18px] text-fg-2 lg:leading-[19px]">{children}</p>
    </div>
  );
}

type InputKind = "text" | "date" | "number" | "money";

function toInputValue(value: string | number, kind: InputKind): string {
  if (kind === "money" && typeof value === "number") {
    // Minor units → "500000" or "1712,50" for editing.
    const whole = Math.trunc(value / 100);
    const cents = Math.abs(value % 100);
    return cents ? `${whole},${String(cents).padStart(2, "0")}` : String(whole);
  }
  return String(value);
}

/** Display value with an inline editor. Commits on Enter or blur, Escape restores. */
export function EditableValue({
  value,
  display,
  kind = "text",
  options,
  onCommit,
  editing,
  onEditingChange,
  className,
  inputClassName,
  ariaLabel,
}: {
  value: string | number;
  display?: ReactNode;
  kind?: InputKind;
  options?: { value: string; label: string }[];
  onCommit: (value: string) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  className?: string;
  inputClassName?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(toInputValue(value, kind));
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(toInputValue(value, kind));
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [editing, value, kind]);

  if (!editing) return <span className={className}>{display ?? value}</span>;

  const commit = () => {
    onCommit(draft);
    onEditingChange(false);
  };
  const common = {
    "aria-label": ariaLabel,
    className: cn("w-full min-w-0 rounded-md border border-accent bg-surface px-2 py-1 text-[14px] text-fg outline-none ring-1 ring-accent", inputClassName),
  };
  if (options) {
    return (
      <select
        ref={ref}
        {...common}
        value={draft}
        onChange={(e) => {
          onCommit(e.target.value);
          onEditingChange(false);
        }}
        onBlur={() => onEditingChange(false)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      ref={ref}
      {...common}
      type={kind === "date" ? "date" : "text"}
      inputMode={kind === "number" || kind === "money" ? "decimal" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onEditingChange(false);
      }}
    />
  );
}

/** Boxed field with label row and pencil, used by delivery cards. */
export function FieldBox({
  label,
  flagged,
  mono,
  children,
  onEdit,
  editing,
  className,
}: {
  label: string;
  flagged?: boolean;
  mono?: boolean;
  children: ReactNode;
  onEdit: () => void;
  editing: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-[5px]", className)}>
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-fg-3">{label}</span>
        {flagged ? <VerifyFlag /> : null}
      </span>
      <div
        className={cn(
          "flex h-11 items-center gap-1.5 rounded-lg border bg-sunken px-2.5 lg:h-[38px]",
          flagged ? "border-warning" : "border-border",
          editing && "px-1",
        )}
      >
        <span className={cn("flex min-w-0 flex-1 truncate text-[13px] font-medium text-fg lg:text-sm", mono && "font-mono")}>{children}</span>
        {!editing ? (
          <button type="button" onClick={onEdit} aria-label={`Editar ${label.toLowerCase()}`} className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-surface-2 hover:text-fg">
            <Pencil size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Key/value row with trailing pencil, used by order and payment cards. */
export function KVRow({
  label,
  children,
  flagged,
  onEdit,
  editing,
  mono,
}: {
  label: string;
  children: ReactNode;
  flagged?: boolean;
  onEdit: () => void;
  editing: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex min-h-[26px] items-center gap-2.5">
      <span className="w-24 shrink-0 text-[13px] text-fg-3">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cn("min-w-0 truncate text-sm font-medium text-fg", mono && "font-mono", editing && "flex-1")}>{children}</span>
        {flagged && !editing ? <VerifyFlag variant="pill" /> : null}
      </span>
      {!editing ? (
        <button type="button" onClick={onEdit} aria-label={`Editar ${label.toLowerCase()}`} className="-mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg">
          <Pencil size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** Money typed by the user → integer minor units. */
export { parseMoneyInput } from "@/domain/format";

/** Quantity typed by the user ("6,5", "3.000") → number, or null. */
export function parseQuantityInput(raw: string): number | null {
  let text = raw.trim().replace(/[^\d.,]/g, "");
  if (!text) return null;
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}
