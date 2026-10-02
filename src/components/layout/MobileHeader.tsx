import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { cn } from "../ui/cn";

export function MobileHeader({
  eyebrow,
  title,
  actions,
  back,
  className,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  back?: { to: string; label: string; params?: Record<string, string> };
  className?: string;
}) {
  return (
    <header className={cn("flex min-h-14 items-center gap-3 pt-2 pr-4 pl-5 lg:hidden", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        {back ? (
          <Link to={back.to} params={back.params} className="flex items-center text-xs text-fg-3">
            ‹ {back.label}
          </Link>
        ) : eyebrow ? (
          <span className="truncate text-xs text-fg-3">{eyebrow}</span>
        ) : null}
        <h1 className="truncate text-xl font-semibold tracking-[-0.3px] text-fg">{title}</h1>
      </div>
      {actions}
    </header>
  );
}

/** Large back link used on the mobile order detail ("‹ Pedidos"). */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="flex h-11 items-center gap-1 text-[15px] font-medium text-accent">
      <ChevronLeft size={20} />
      {label}
    </Link>
  );
}

export function DesktopHeader({ title, subtitle, actions, breadcrumb, badges }: { title: string; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode; badges?: ReactNode }) {
  return (
    <div className="hidden flex-col gap-4 lg:flex">
      {breadcrumb}
      <div className="flex items-end gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] font-semibold tracking-[-0.5px] text-fg">{title}</h1>
            {badges}
          </div>
          {subtitle ? <div className="text-sm text-fg-2">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="flex items-center gap-2 text-[13px]" aria-label="Ruta">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-2">
          {item.to ? (
            <Link to={item.to} className="text-fg-3 hover:text-fg">
              {item.label}
            </Link>
          ) : (
            <span className="text-fg-2">{item.label}</span>
          )}
          {i < items.length - 1 ? <span className="text-fg-3">›</span> : null}
        </span>
      ))}
    </nav>
  );
}
