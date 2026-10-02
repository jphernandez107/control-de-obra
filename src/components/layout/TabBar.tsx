import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "../ui/cn";
import { NAV, isActive } from "./nav";

export function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      className="sticky bottom-0 z-30 flex shrink-0 border-t border-border bg-surface px-2 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] lg:hidden"
      aria-label="Principal"
    >
      {NAV.map((item) => {
        const active = isActive(item, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            className={cn("flex min-h-11 flex-1 flex-col items-center gap-1 py-1.5 text-[11px]", active ? "font-semibold text-accent" : "font-medium text-fg-3")}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={22} strokeWidth={1.75} />
            {item.shortLabel}
          </Link>
        );
      })}
    </nav>
  );
}
