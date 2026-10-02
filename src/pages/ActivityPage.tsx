import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Download, History, SlidersHorizontal } from "lucide-react";
import type { ActivityEvent, ActivityFilters, ActivityKind } from "@/domain/types";
import { formatDate, formatTime, relativeDayLabel } from "@/domain/format";
import { ActivityIcon, ActivityItem, activityMeta } from "@/components/domain/ActivityItem";
import { DesktopHeader, MobileHeader } from "@/components/layout/MobileHeader";
import { Page } from "@/components/layout/Page";
import { Button, IconButton } from "@/components/ui/Button";
import { FilterChip, SearchField, SelectChip } from "@/components/ui/Fields";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useActivity, useSupplierOptions } from "@/queries";
import { useAssistant } from "@/features/assistant/AssistantProvider";
import { downloadCsv } from "@/lib/csv";

const KINDS = Object.keys(activityMeta) as ActivityKind[];

function daysBefore(date: string, days: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function groupByDay(events: ActivityEvent[]) {
  const groups: { day: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const day = e.at.slice(0, 10);
    const last = groups.at(-1);
    if (last?.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }
  return groups;
}

export function ActivityPage() {
  const navigate = useNavigate();
  const assistant = useAssistant();
  const today = assistant.today;
  const suppliers = useSupplierOptions();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"" | ActivityKind>("");
  const [supplierId, setSupplierId] = useState("");
  const [recentOnly, setRecentOnly] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  const filters: ActivityFilters = useMemo(
    () => ({
      search: search.trim() || undefined,
      kinds: kind ? [kind] : undefined,
      supplierId: supplierId || undefined,
      from: recentOnly && today ? daysBefore(today, 15) : undefined,
      to: recentOnly && today ? today : undefined,
    }),
    [search, kind, supplierId, recentOnly, today],
  );
  const { data, isPending, isError, refetch, isRefetching, errorUpdatedAt } = useActivity(filters);
  const groups = groupByDay(data?.events ?? []);
  const rangeLabel = today ? `${formatDate(daysBefore(today, 15))} – ${formatDate(today)}` : "Últimos 15 días";
  const anyFilter = Boolean(search || kind || supplierId);
  const clear = () => {
    setSearch("");
    setKind("");
    setSupplierId("");
    setRecentOnly(false);
  };
  const openEvent = (e: ActivityEvent) => {
    if (e.orderId) navigate({ to: "/pedidos/$orderId", params: { orderId: e.orderId } });
    else if (e.kind === "computo_actualizado") navigate({ to: "/materiales" });
    else if (e.supplierId) navigate({ to: "/proveedores/$supplierId", params: { supplierId: e.supplierId } });
  };
  const stamp = errorUpdatedAt && today ? `Último intento ${formatDate(today)} ${new Date(errorUpdatedAt).toTimeString().slice(0, 5)}` : undefined;
  const supplierOptions = (suppliers.data ?? []).map((s) => ({ value: s.id, label: s.name }));
  const kindOptions = KINDS.map((k) => ({ value: k, label: activityMeta[k].label }));

  const timeline = (compact: boolean) => (
    <div className="flex flex-col gap-3.5">
      {groups.map((g) => (
        <Fragment key={g.day}>
          <div className="flex items-center gap-2 pb-1">
            <span className="text-[13px] font-semibold text-fg">{today ? relativeDayLabel(g.day, today) : ""}</span>
            <span className="font-mono text-xs text-fg-3">{formatDate(g.day)}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="flex flex-col">
            {g.events.map((e, i) => (
              <ActivityItem key={e.id} event={e} time={formatTime(e.at)} last={i === g.events.length - 1} compact={compact} onClick={() => openEvent(e)} />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );

  return (
    <Page>
      <MobileHeader eyebrow="Casa Córdoba" title="Actividad" actions={<IconButton icon={SlidersHorizontal} label="Filtros" onClick={() => setSheetOpen(true)} />} />
      <DesktopHeader
        title="Actividad"
        subtitle="Todo lo que se registró o corrigió en la obra, en orden cronológico"
        actions={
          <Button variant="secondary" icon={Download} onClick={() => downloadCsv("actividad.csv", ["Fecha y hora", "Tipo", "Descripción", "Motivo"], (data?.events ?? []).map((e) => [e.at.replace("T", " "), e.title, e.description, e.reason ?? ""]))}>
            Exportar
          </Button>
        }
      />

      <div className="hidden items-center gap-2 lg:flex">
        <SearchField placeholder="Buscar en la actividad" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} containerClassName="w-[280px]" />
        <SelectChip label="Tipo: todos" value={kind} onChange={setKind} options={kindOptions} />
        <SelectChip label="Proveedor" value={supplierId} onChange={setSupplierId} options={supplierOptions} allLabel="Todos los proveedores" />
        <FilterChip label={recentOnly ? rangeLabel : "Fecha"} active={recentOnly} onClick={() => setRecentOnly(true)} onRemove={() => setRecentOnly(false)} />
        {anyFilter ? (
          <button type="button" onClick={clear} className="ml-1 text-[13px] font-medium text-accent">
            Limpiar filtros
          </button>
        ) : null}
        <span className="flex-1" />
        {data ? <span className="text-[13px] text-fg-3">{data.total} {data.total === 1 ? "evento" : "eventos"}</span> : null}
      </div>
      <div className="no-scrollbar flex gap-2 overflow-x-auto px-5 pb-3 lg:hidden">
        <SelectChip label="Tipo" value={kind} onChange={setKind} options={kindOptions} />
        <SelectChip label="Proveedor" value={supplierId} onChange={setSupplierId} options={supplierOptions} />
        <FilterChip label={recentOnly ? "Últimos 15 días" : "Fecha"} active={recentOnly} onClick={() => setRecentOnly(true)} onRemove={() => setRecentOnly(false)} />
      </div>

      {isPending ? (
        <div className="flex flex-col gap-5 px-5 lg:px-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-7 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-2.5 w-72 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <>
          <ErrorState title="No se pudo cargar la actividad" description="Revisa tu conexión e intenta de nuevo. Tus registros están guardados y no se perdió nada." onRetry={() => refetch()} retrying={isRefetching} stamp={stamp} mobile className="flex-1 px-5 lg:hidden" />
          <ErrorState title="No se pudo cargar la actividad" onRetry={() => refetch()} retrying={isRefetching} stamp={stamp} className="hidden rounded-[14px] border border-border bg-surface py-24 lg:flex" />
        </>
      ) : (
        <div className="flex gap-10">
          <div className="min-w-0 flex-1 px-5 lg:px-0">
            {groups.length === 0 ? (
              <EmptyState
                icon={History}
                title={anyFilter || recentOnly ? "No hay actividad con estos filtros" : "Todavía no hay actividad"}
                description={anyFilter || recentOnly ? "Prueba ampliando el período o quitando filtros." : "Cada pedido, entrega, pago o corrección que registres aparecerá acá."}
                actions={
                  anyFilter || recentOnly ? (
                    <Button variant="secondary" onClick={clear}>
                      Ver toda la actividad
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="hidden lg:block">{timeline(false)}</div>
                <div className="lg:hidden">{timeline(true)}</div>
              </>
            )}
          </div>
          <aside className="hidden w-[280px] shrink-0 flex-col gap-4 lg:flex">
            <h2 className="text-sm font-semibold text-fg">En este período</h2>
            <div className="flex flex-col">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(kind === k ? "" : k)}
                  className={cn("flex h-11 items-center gap-2.5 border-b border-border text-left hover:bg-sunken", kind === k && "bg-sunken")}
                >
                  <ActivityIcon event={{ kind: k }} size={24} />
                  <span className="flex-1 text-[13px] text-fg-2">{activityMeta[k].label}</span>
                  <span className="font-mono text-[13px] text-fg">{data?.countsByKind[k] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 p-3.5">
              <span className="text-[13px] font-semibold text-fg">Nada se borra</span>
              <span className="text-xs leading-[18px] text-fg-2">Cada corrección queda registrada con el valor anterior, el nuevo y quién la hizo.</span>
            </div>
          </aside>
        </div>
      )}

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Filtrar actividad"
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={clear}>
              Limpiar
            </Button>
            <Button size="lg" className="flex-1" onClick={() => setSheetOpen(false)}>
              Ver {data?.total ?? 0} eventos
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 pb-4">
          <SearchField placeholder="Buscar en la actividad" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} containerClassName="h-11" />
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium text-fg-2">Tipo</span>
            {KINDS.map((k) => (
              <button key={k} type="button" onClick={() => setKind(kind === k ? "" : k)} className={cn("flex min-h-11 items-center gap-2.5 rounded-lg px-2 text-left", kind === k && "bg-accent-soft")}>
                <ActivityIcon event={{ kind: k }} size={24} />
                <span className="flex-1 text-sm text-fg">{activityMeta[k].label}</span>
                <span className="font-mono text-[13px] text-fg-3">{data?.countsByKind[k] ?? 0}</span>
              </button>
            ))}
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-2">
            <span className="text-sm text-fg">Solo últimos 15 días</span>
            <input type="checkbox" checked={recentOnly} onChange={(e) => setRecentOnly(e.target.checked)} className="size-5 accent-[var(--accent)]" />
          </label>
        </div>
      </Sheet>
    </Page>
  );
}
