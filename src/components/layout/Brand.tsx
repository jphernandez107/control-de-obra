import { cn } from "../ui/cn";

/** "CC" mark + project name, as in the sidebar. */
export function Brand({ large, className }: { large?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "flex items-center justify-center bg-accent font-bold text-on-accent",
          large ? "size-11 rounded-[12px] text-[15px]" : "size-[34px] rounded-[9px] text-[13px]",
        )}
      >
        CC
      </span>
      <span className="flex flex-col gap-px">
        <span className={cn("font-semibold text-fg", large ? "text-[17px]" : "text-[15px]")}>Casa Córdoba</span>
        <span className={cn("text-fg-3", large ? "text-[13px]" : "text-xs")}>Control de Obra</span>
      </span>
    </span>
  );
}
