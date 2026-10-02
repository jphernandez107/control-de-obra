import { cn } from "./cn";

export type ProgressTone = "info" | "success" | "warning" | "danger" | "neutral" | "accent" | "ai";

const fills: Record<ProgressTone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-fg-3",
  accent: "bg-accent",
  ai: "bg-ai",
};

export function Progress({ value, tone = "info", className, height = 6 }: { value: number; tone?: ProgressTone; className?: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("w-full overflow-hidden rounded-[3px] bg-surface-2", className)} style={{ height }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-[3px]", fills[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Stacked bar: each segment as a percentage of the total width. */
export function SplitProgress({ segments, className, height = 6 }: { segments: { value: number; tone: ProgressTone }[]; className?: string; height?: number }) {
  return (
    <div className={cn("flex w-full overflow-hidden rounded-[3px] bg-surface-2", className)} style={{ height }}>
      {segments.map((s, i) => (
        <div key={i} className={cn("h-full", fills[s.tone])} style={{ width: `${Math.max(0, Math.min(100, s.value))}%` }} />
      ))}
    </div>
  );
}

/** Computation bar: the part above 100% is drawn in red at the end. */
export function ComputationBar({ percent, tone, className, height = 6, split }: { percent: number; tone: ProgressTone; className?: string; height?: number; split?: boolean }) {
  if (percent <= 100 || !split) return <Progress value={percent} tone={tone} className={className} height={height} />;
  const base = (100 / percent) * 100;
  return <SplitProgress segments={[{ value: base, tone: "warning" }, { value: 100 - base, tone: "danger" }]} className={className} height={height} />;
}
