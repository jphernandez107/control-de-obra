import { useNavigate } from "@tanstack/react-router";
import { CircleCheck, X } from "lucide-react";
import type { AttentionGroup } from "@/domain/types";
import { AttentionRow } from "@/components/domain/AttentionRow";
import { IconButton } from "@/components/ui/Button";
import { DesktopHeader } from "@/components/layout/MobileHeader";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { useDashboard } from "@/queries";

const GROUPS: { id: AttentionGroup; label: string }[] = [
  { id: "confirmar", label: "Para confirmar" },
  { id: "computo", label: "Cómputo" },
  { id: "entregas", label: "Entregas" },
  { id: "pagos", label: "Pagos y saldos" },
  { id: "documentos", label: "Documentos" },
];

export function AttentionPage() {
  const navigate = useNavigate();
  const { data, isPending, isError, refetch, isRefetching } = useDashboard();
  const items = data?.attention ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-2 pb-6 lg:gap-6 lg:px-10 lg:py-8">
      <header className="flex min-h-14 items-center gap-3 pt-2 pr-4 pl-5 lg:hidden">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-xs text-fg-3">{items.length} temas · ordenados por prioridad</span>
          <h1 className="text-xl font-semibold tracking-[-0.3px] text-fg">Requiere atención</h1>
        </div>
        <IconButton icon={X} label="Cerrar" size={44} onClick={() => navigate({ to: "/" })} />
      </header>
      <DesktopHeader title="Requiere atención" subtitle={`${items.length} temas ordenados por prioridad`} />
      {isPending ? (
        <div className="flex flex-col gap-3 px-4 lg:px-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState title="No se pudo cargar" onRetry={() => refetch()} retrying={isRefetching} />
      ) : items.length === 0 ? (
        <EmptyState icon={CircleCheck} title="Nada requiere atención" description="Aquí verás entregas parciales, saldos pendientes y registros por confirmar." />
      ) : (
        <div className="flex flex-col gap-2 px-4 lg:rounded-[14px] lg:border lg:border-border lg:bg-surface lg:px-5 lg:py-3">
          {GROUPS.map((g) => {
            const groupItems = items.filter((i) => i.group === g.id);
            if (!groupItems.length) return null;
            return (
              <section key={g.id} className="flex flex-col">
                <h2 className="pt-2 pb-1 font-mono text-[11px] tracking-[1px] text-fg-3 uppercase">{g.label}</h2>
                {groupItems.map((item) => (
                  <AttentionRow key={item.id} item={item} />
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
