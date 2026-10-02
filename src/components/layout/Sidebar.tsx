import { Link, useRouterState } from "@tanstack/react-router";
import { LogOut, Moon, Sun, Users } from "lucide-react";
import { useTheme } from "@/app/theme";
import { useAssistant } from "@/features/assistant/AssistantProvider";
import { formatDate, initialsOf } from "@/domain/format";
import { useDashboard, useLogout, useSession } from "@/queries";
import { cn } from "../ui/cn";
import { Brand } from "./Brand";
import { NAV, isActive } from "./nav";

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggle } = useTheme();
  const { pendingCount } = useAssistant();
  const { data } = useDashboard();
  const session = useSession();
  const logout = useLogout();
  const user = session.data?.user;
  const usersActive = pathname.startsWith("/usuarios");
  const computation = data?.computation;

  return (
    <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col gap-1 border-r border-border bg-bg px-4 py-5 lg:flex">
      <Link to="/" className="px-2 pt-1 pb-5">
        <Brand />
      </Link>
      <nav className="flex flex-col gap-1" aria-label="Principal">
        {NAV.map((item) => {
          const active = isActive(item, pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors",
                active ? "bg-surface font-semibold text-fg" : "font-medium text-fg-2 hover:bg-surface-2",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={18} className={active ? "text-accent" : "text-fg-2"} />
              <span className="flex-1">{item.label}</span>
              {item.to === "/" && pendingCount > 0 ? (
                <span className="flex h-5 items-center rounded-[10px] bg-ai-soft px-[7px] font-mono text-[11px] font-medium text-ai">{pendingCount}</span>
              ) : null}
            </Link>
          );
        })}
        {user?.isAdmin ? (
          <Link
            to="/usuarios"
            className={cn(
              "flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors",
              usersActive ? "bg-surface font-semibold text-fg" : "font-medium text-fg-2 hover:bg-surface-2",
            )}
            aria-current={usersActive ? "page" : undefined}
          >
            <Users size={18} className={usersActive ? "text-accent" : "text-fg-2"} />
            <span className="flex-1">Usuarios</span>
          </Link>
        ) : null}
      </nav>
      <div className="flex-1" />
      <Link to="/materiales" className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface p-3.5 hover:bg-sunken">
        <span className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", computation?.loaded ? "bg-success" : "bg-fg-3")} />
          <span className="text-[13px] font-semibold text-fg">{computation?.loaded ? "Cómputo cargado" : "Cómputo sin cargar"}</span>
        </span>
        <span className="text-xs leading-[17px] text-fg-3">
          {computation?.loaded
            ? `${computation.linkedMaterials} materiales · actualizado ${computation.updatedAt ? formatDate(computation.updatedAt) : ""}`
            : "Los movimientos se podrán comparar cuando lo cargues."}
        </span>
      </Link>
      <div className="flex items-center gap-1 pt-3.5">
        <Link to="/usuarios" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-surface-2" title="Tu sesión">
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-fg-2">{user ? initialsOf(user.name) : ""}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="truncate text-[13px] font-medium text-fg">{user?.name ?? "…"}</span>
            <span className="truncate text-xs text-fg-3">{user ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ""}</span>
          </span>
        </Link>
        <button
          type="button"
          onClick={toggle}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-surface-2 hover:text-fg"
          aria-label={theme === "dark" ? "Usar modo claro" : "Usar modo oscuro"}
          title={theme === "dark" ? "Modo claro" : "Modo oscuro"}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-surface-2 hover:text-fg"
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
