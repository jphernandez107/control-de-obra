import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { cn } from "./cn";

function useDismiss(open: boolean, onClose: () => void, panel: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose, panel]);
}

/**
 * Bottom sheet on mobile, centered dialog from `lg` up. The design replaces
 * modals with bottom sheets on phones.
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  showClose = true,
  className,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  showClose?: boolean;
  className?: string;
  size?: "md" | "lg";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDismiss(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center lg:p-6">
      <div className="absolute inset-0 animate-fade-in bg-scrim" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[92dvh] w-full animate-sheet-in flex-col rounded-t-[20px] bg-surface shadow-sheet outline-none lg:max-h-[86vh] lg:animate-pop-in lg:rounded-[16px]",
          size === "md" ? "lg:max-w-[480px]" : "lg:max-w-[640px]",
          className,
        )}
      >
        <div className="flex justify-center pt-2 pb-1 lg:hidden">
          <span className="h-1 w-9 rounded-full bg-border-strong" />
        </div>
        {title ? (
          <div className="flex items-start gap-3 px-4 pt-2 pb-3 lg:px-6 lg:pt-5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 id={titleId} className="text-lg font-semibold text-fg">
                {title}
              </h2>
              {subtitle ? <p className="text-[13px] text-fg-3">{subtitle}</p> : null}
            </div>
            {showClose ? <IconButton icon={X} label="Cerrar" size={44} onClick={onClose} /> : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 lg:px-6">{children}</div>
        {footer ? <div className="flex items-center gap-3 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] lg:px-6 lg:pb-5">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Side drawer from the right on desktop; bottom sheet on mobile. */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-end lg:items-stretch">
      <div className="absolute inset-0 animate-fade-in bg-scrim" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex max-h-[85dvh] w-full animate-sheet-in flex-col rounded-t-[20px] bg-surface shadow-sheet outline-none lg:max-h-none lg:w-[400px] lg:animate-fade-in lg:rounded-none lg:border-l lg:border-border"
      >
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
          <h2 className="flex-1 text-base font-semibold text-fg">{title}</h2>
          <IconButton icon={X} label="Cerrar" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
