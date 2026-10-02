import type { LucideIcon } from "lucide-react";
import { CloudOff, LoaderCircle, RefreshCw, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn("animate-shimmer rounded-md bg-surface-2", className)} style={style} />;
}

export function StateIcon({ icon: Icon, tone = "neutral", round }: { icon: LucideIcon; tone?: "neutral" | "danger"; round?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center",
        round ? "size-16 rounded-full" : "size-12 rounded-[12px]",
        tone === "danger" ? "bg-danger-soft text-danger" : "bg-surface-2 text-fg-2",
      )}
    >
      <Icon size={round ? 26 : 20} />
    </span>
  );
}

export function EmptyState({
  icon = SearchX,
  title,
  description,
  actions,
  className,
  round,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  round?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      <StateIcon icon={icon} round={round} />
      <div className="flex flex-col items-center gap-2">
        <h3 className="text-[17px] font-semibold text-fg">{title}</h3>
        {description ? <p className="max-w-[520px] text-sm leading-[21px] text-fg-3">{description}</p> : null}
      </div>
      {actions ? <div className="mt-1 flex flex-wrap items-center justify-center gap-3">{actions}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  description = "Revisa tu conexión. Tus registros están guardados; no se perdió nada.",
  onRetry,
  retrying,
  stamp,
  className,
  mobile,
}: {
  title: string;
  description?: string;
  onRetry: () => void;
  retrying?: boolean;
  stamp?: string;
  className?: string;
  mobile?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      <StateIcon icon={CloudOff} tone={mobile ? "neutral" : "danger"} round={mobile} />
      <div className="flex flex-col items-center gap-2">
        <h3 className={cn("font-semibold text-fg", mobile ? "text-lg" : "text-[17px]")}>{title}</h3>
        <p className={cn("max-w-[520px] leading-[21px]", mobile ? "text-[15px] text-fg-2" : "text-sm text-fg-3")}>{description}</p>
      </div>
      <Button icon={RefreshCw} onClick={onRetry} loading={retrying} className={cn("mt-1", mobile && "w-full")}>
        Reintentar
      </Button>
      {stamp ? <p className="font-mono text-xs text-fg-3">{stamp}</p> : null}
    </div>
  );
}

export function LoadingNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-fg-3">
      <LoaderCircle size={14} className="animate-spin" />
      {children}
    </p>
  );
}
