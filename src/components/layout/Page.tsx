import type { ReactNode } from "react";
import { cn } from "../ui/cn";

/** Desktop page frame (padding per design); mobile pages manage their own chrome. */
export function Page({ children, className, surface }: { children: ReactNode; className?: string; surface?: boolean }) {
  return (
    <div className={cn("flex w-full flex-1 flex-col pb-6 lg:gap-6 lg:px-10 lg:pt-8 lg:pb-10", surface && "lg:bg-surface lg:px-8 lg:pt-7", className)}>{children}</div>
  );
}

export function Kpi({ label, value, sub, dot, valueClassName, className }: { label: string; value: ReactNode; sub?: ReactNode; dot?: string; valueClassName?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-1 px-5", className)}>
      <span className="flex items-center gap-1.5 text-[13px] text-fg-3">
        {dot ? <span className={cn("size-[7px] rounded-full", dot)} /> : null}
        {label}
      </span>
      <span className={cn("truncate font-mono text-[22px] font-semibold tracking-[-0.5px] text-fg", valueClassName)}>{value}</span>
      {sub ? <span className="truncate text-xs text-fg-3">{sub}</span> : null}
    </div>
  );
}

export function KpiStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("hidden border-y border-border py-[18px] lg:flex [&>*+*]:border-l [&>*+*]:border-border", className)}>{children}</div>;
}

export function Footnote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-xs text-fg-3", className)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

export function SegmentChip({ label, count, active, onClick }: { label: string; count?: number; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[18px] border px-3 text-sm font-medium whitespace-nowrap",
        active ? "border-fg bg-fg text-bg" : "border-border bg-surface text-fg-2",
      )}
    >
      {label}
      {count !== undefined ? <span className={cn("font-mono text-xs font-normal", active ? "text-bg" : "text-fg-3")}>{count}</span> : null}
    </button>
  );
}
