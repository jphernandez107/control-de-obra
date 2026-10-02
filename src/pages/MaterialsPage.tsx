import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Boxes, Calculator, ChevronRight, Download, Flag, RefreshCw, Search, SearchX, Truck, Upload, X } from "lucide-react";
import type { ComputationStatus, MaterialSummary } from "@/domain/types";
import { formatDate, formatNumber, pluralize } from "@/domain/format";
import { DesktopHeader, MobileHeader } from "@/components/layout/MobileHeader";
import { Footnote, Page } from "@/components/layout/Page";
import { Button, IconButton } from "@/components/ui/Button";
import { FilterChip, SearchField, SelectChip } from "@/components/ui/Fields";
import { Pill } from "@/components/ui/Pill";
import { ComputationBar, type ProgressTone } from "@/components/ui/Progress";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useMaterials, useUploadComputation } from "@/queries";
import { ComputationImportSheet } from "@/components/domain/ComputationImportSheet";
import { errorMessage } from "@/services/api/client";
import type { ComputationPreview } from "@/services/types";
import { downloadCsv } from "@/lib/csv";

type Status = ComputationStatus;

const STATUS_LABEL: Record<Status, string> = {
  supera: "Supera el cómputo",
  cerca: "Cerca del cómputo",
  alcanzado: "Cómputo alcanzado",
  dentro: "Dentro de lo previsto",
  sin_computo: "Sin cómputo",
};

function statusOf(m: MaterialSummary): Status {
  return m.computation?.status ?? "sin_computo";
}

function barTone(s: Status): ProgressTone {
  return s === "supera" ? "danger" : s === "cerca" ? "warning" : s === "alcanzado" ? "accent" : "neutral";
}

function pctColor(s: Status) {
  return s === "supera" ? "text-danger font-semibold" : s === "cerca" ? "text-warning font-semibold" : s === "alcanzado" ? "text-accent font-semibold" : "text-fg-2";
}

function normalize(t: string) {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function shortName(name: string) {
  return name.replace(/ x 12 m$/, "");
}

export function MaterialsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isPending, isError, refetch, isRefetching } = useMaterials();
  const upload = useUploadComputation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | Status>("");
  const [category, setCategory] = useState("");
  const [supplier, setSupplier] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);

  const materials = data?.materials ?? [];
  const loaded = Boolean(data?.computation.loaded);
  const categories = useMemo(() => [...new Set(materials.map((m) => m.category))], [materials]);
  const suppliers = useMemo(() => [...new Set(materials.map((m) => m.supplierName))], [materials]);

  const filtered = materials.filter((m) => {
    const q = normalize(search.trim());
    if (q && !normalize(`${m.name} ${m.category} ${m.supplierName}`).includes(q)) return false;
    if (status && statusOf(m) !== status) return false;
    if (category && m.category !== category) return false;
    if (supplier && m.supplierName !== supplier) return false;
    if (pendingOnly && m.pendingDelivery === 0) return false;
    return true;
  });
  const anyFilter = Boolean(search || status || category || supplier || pendingOnly);
  const clear = () => {
    setSearch("");
    setStatus("");
    setCategory("");
    setSupplier("");
    setPendingOnly(false);
  };
  const open = (m: MaterialSummary) => navigate({ to: "/materiales/$materialId", params: { materialId: m.id } });
  const suggestions = materials.filter((m) => (category ? m.category === category : normalize(m.name).includes(normalize(search.trim()).slice(0, 4)))).slice(0, 3);
  const worst = materials.filter((m) => m.computation?.status === "supera").sort((a, b) => (b.computation?.variation ?? 0) - (a.computation?.variation ?? 0))[0];

  const startUpload = () => fileRef.current?.click();
  const [preview, setPreview] = useState<ComputationPreview | null>(null);
  const onUpload = (file?: File) => {
    if (!file) return;
    upload.mutate(file, {
      onSuccess: setPreview,
      onError: (error) => toast(errorMessage(error, "No se pudo leer la planilla."), "info"),
    });
  };
  const exportCsv = () =>
    downloadCsv(
      "materiales-y-computo.csv",
      ["Material", "Categoría", "Unidad", "Pedido", "Entregado", "Pendiente de entrega", "Cómputo", "% del cómputo", "Estado"],
      materials.map((m) => [m.name, m.category, m.unit, m.ordered, m.delivered, m.pendingDelivery, m.computation?.expected ?? null, m.computation?.percent ?? null, STATUS_LABEL[statusOf(m)]]),
    );

  const statusOptions = (["supera", "cerca", "alcanzado", "dentro", "sin_computo"] as Status[])
    .filter((s) => materials.some((m) => statusOf(m) === s))
    .map((s) => ({ value: s, label: STATUS_LABEL[s] }));

  const header = (
    <>
      <MobileHeader
        eyebrow={loaded && data?.computation.updatedAt ? `Cómputo cargado ${formatDate(data.computation.updatedAt)}` : "Casa Córdoba"}
        title="Materiales"
        actions={<IconButton icon={Search} label="Buscar material" onClick={() => document.getElementById("material-search")?.focus()} />}
      />
      <DesktopHeader
        title="Materiales y cómputo"
        subtitle={
          data
            ? loaded
              ? `Cómputo cargado el ${data.computation.updatedAt ? formatDate(data.computation.updatedAt) : ""} · ${pluralize(data.computation.linkedMaterials ?? 0, "material vinculado", "materiales vinculados")}`
              : `${pluralize(materials.length, "material con movimientos", "materiales con movimientos")} · ${pluralize(data.orderCount, "pedido")}`
            : undefined
        }
        actions={
          loaded ? (
            <>
              <Button variant="ghost" icon={Download} onClick={() => exportCsv()}>
                Exportar
              </Button>
              <Button variant="secondary" icon={RefreshCw} loading={upload.isPending} onClick={startUpload}>
                Actualizar cómputo
              </Button>
            </>
          ) : (
            <Button variant="secondary" icon={Download} onClick={() => exportCsv()}>
              Exportar
            </Button>
          )
        }
      />
    </>
  );

  const hiddenInput = (
    <input
      ref={fileRef}
      type="file"
      accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      className="hidden"
      onChange={(e) => {
        onUpload(e.target.files?.[0] ?? undefined);
        e.target.value = "";
      }}
    />
  );

  if (isPending) {
    return (
      <Page>
        {header}
        <div className="flex flex-col gap-3 px-5 lg:px-0">
          <Skeleton className="h-28 w-full rounded-[14px]" />
          <Skeleton className="h-10 w-full max-w-[320px] rounded-[10px]" />
          <Skeleton className="h-[420px] w-full rounded-[14px]" />
        </div>
      </Page>
    );
  }
  if (isError || !data) {
    return (
      <Page>
        {header}
        <ErrorState title="No pudimos cargar los materiales" onRetry={() => refetch()} retrying={isRefetching} className="flex-1" />
      </Page>
    );
  }
  if (materials.length === 0) {
    return (
      <Page>
        {header}
        <EmptyState
          icon={Boxes}
          title="Todavía no hay materiales"
          description="Aparecen solos cuando registras pedidos. El cómputo se puede cargar en cualquier momento."
          actions={
            <Button variant="secondary" icon={Upload} loading={upload.isPending} onClick={startUpload}>
              Cargar cómputo
            </Button>
          }
          className="flex-1"
        />
        {hiddenInput}
        <ComputationImportSheet preview={preview} onClose={() => setPreview(null)} />
      </Page>
    );
  }

  const noResults = filtered.length === 0;

  return (
    <Page>
      {header}

      {!loaded ? (
        <>
          <div className="hidden items-center gap-7 rounded-[14px] border border-border-strong bg-surface p-7 lg:flex">
            <span className="flex size-[72px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Calculator size={30} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <h2 className="text-lg font-semibold tracking-[-0.3px] text-fg">Aún no hay un cómputo cargado</h2>
              <p className="text-sm leading-5 text-fg-2">
                Puedes seguir registrando pedidos y entregas como hasta ahora. Cuando cargues el cómputo (planilla o PDF), vincularemos cada material para comparar lo pedido con lo previsto.
              </p>
              <div className="flex flex-wrap gap-5 pt-1.5">
                {["Sube la planilla del cómputo", "Revisa la vinculación de materiales", "Compara pedido y previsto"].map((t, i) => (
                  <span key={t} className="flex items-center gap-2 text-[13px] text-fg-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px] font-semibold text-fg-2">{i + 1}</span>
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <Button icon={Upload} loading={upload.isPending} onClick={startUpload}>
                Cargar cómputo
              </Button>
              <Button variant="ghost" onClick={() => setExampleOpen(true)}>
                Ver un ejemplo
              </Button>
            </div>
          </div>
          <div className="mx-5 mb-4 flex flex-col gap-3 rounded-[14px] border border-border-strong bg-surface p-[18px] lg:hidden">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Calculator size={18} />
              </span>
              <h2 className="text-base font-semibold text-fg">Aún no hay un cómputo cargado</h2>
            </div>
            <p className="text-sm leading-[21px] text-fg-2">Sigue registrando pedidos y entregas. Cuando cargues el cómputo, vincularemos cada material para comparar lo pedido con lo previsto.</p>
            <Button icon={Upload} size="lg" className="w-full" loading={upload.isPending} onClick={startUpload}>
              Cargar cómputo
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="hidden flex-wrap items-center gap-x-6 gap-y-3 lg:flex">
            {(
              [
                ["supera", "bg-danger"],
                ["cerca", "bg-warning"],
                ["alcanzado", "bg-accent"],
                ["dentro", "bg-fg-3"],
              ] as [Exclude<Status, "sin_computo">, string][]
            ).map(([s, dot]) => (
              <button key={s} type="button" onClick={() => setStatus(status === s ? "" : s)} className={cn("flex items-center gap-2 rounded-md", status === s && "underline underline-offset-4")}>
                <span className={cn("size-2 rounded-full", dot)} />
                <span className="font-mono text-xl font-semibold text-fg">{data.counts[s]}</span>
                <span className="text-[13px] whitespace-nowrap text-fg-2">{s === "dentro" ? "Dentro de lo previsto" : STATUS_LABEL[s]}</span>
              </button>
            ))}
            {data.counts.sin_computo ? (
              <button type="button" onClick={() => setStatus(status === "sin_computo" ? "" : "sin_computo")} className="flex items-center gap-2">
                <span className="size-2 rounded-full border border-border-strong bg-surface-2" />
                <span className="font-mono text-xl font-semibold text-fg">{data.counts.sin_computo}</span>
                <span className="text-[13px] whitespace-nowrap text-fg-2">Sin cómputo</span>
              </button>
            ) : null}
            <span className="flex-1" />
            {worst ? (
              <Link to="/materiales/$materialId" params={{ materialId: worst.id }} className="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] hover:bg-sunken">
                <Flag size={14} className="text-danger" />
                <span className="whitespace-nowrap text-fg">
                  {shortName(worst.name)} supera por {formatNumber(worst.computation!.variation)} {worst.unit}
                </span>
                <span className="font-semibold text-accent">Revisar</span>
              </Link>
            ) : null}
          </div>
          <div className="grid grid-cols-4 gap-2 px-5 pb-4 lg:hidden">
            {(
              [
                ["supera", "Supera", "bg-danger-soft text-danger"],
                ["cerca", "Cerca", "bg-warning-soft text-warning"],
                ["alcanzado", "Alcanzado", "bg-accent-soft text-accent"],
                ["dentro", "Previsto", "bg-surface-2 text-fg-2"],
              ] as [Exclude<Status, "sin_computo">, string, string][]
            ).map(([s, label, tone]) => (
              <button key={s} type="button" onClick={() => setStatus(status === s ? "" : s)} className={cn("flex flex-col items-start gap-0.5 rounded-[10px] px-2.5 py-2.5", tone, status === s && "ring-2 ring-current")}>
                <span className="font-mono text-lg font-semibold">{data.counts[s]}</span>
                <span className="text-xs">{label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="hidden items-center gap-2 lg:flex">
        <SearchField placeholder="Buscar material" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} containerClassName="w-[320px]" />
        {loaded ? <SelectChip label="Estado" value={status} onChange={setStatus} options={statusOptions} allLabel="Todos los estados" /> : null}
        <SelectChip label="Rubro" value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: c }))} allLabel="Todos los rubros" />
        <SelectChip label="Proveedor" value={supplier} onChange={setSupplier} options={suppliers.map((c) => ({ value: c, label: c }))} allLabel="Todos los proveedores" />
        {!loaded ? <FilterChip label="Con entrega pendiente" active={pendingOnly} onClick={() => setPendingOnly(true)} onRemove={() => setPendingOnly(false)} /> : null}
        {anyFilter ? (
          <button type="button" onClick={clear} className="ml-1 text-[13px] font-medium text-accent">
            Limpiar filtros
          </button>
        ) : null}
        <span className="flex-1" />
        {!loaded ? <span className="text-[13px] text-fg-3">Cantidades acumuladas de todos los pedidos</span> : null}
      </div>

      <div className="flex flex-col gap-3 px-5 lg:hidden">
        <SearchField
          id="material-search"
          placeholder="Buscar material"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch("")}
          containerClassName={cn("h-11", search && "border-accent ring-1 ring-accent")}
        />
        {search || category || status ? (
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            <SelectChip label="Rubro" value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: `Rubro: ${c}` }))} />
            {loaded ? <SelectChip label="Estado" value={status} onChange={setStatus} options={statusOptions} /> : null}
          </div>
        ) : null}
        {!noResults ? (
          <div className="flex items-center justify-between pt-1 text-[13px]">
            <span className="font-medium text-fg-2">{pluralize(filtered.length, "material", "materiales")}</span>
            {!loaded ? <span className="text-fg-3">Pedido · Entregado</span> : null}
          </div>
        ) : null}
      </div>

      {noResults ? (
        <>
          <EmptyState
            icon={SearchX}
            title="No hay materiales que coincidan"
            description={search ? `Ningún material coincide con «${search}».` : "Prueba quitando algún filtro."}
            actions={
              <Button variant="secondary" onClick={clear}>
                Quitar filtros
              </Button>
            }
            className="hidden rounded-[14px] border border-border bg-surface lg:flex"
          />
          <div className="flex flex-col gap-4 px-5 lg:hidden">
            <EmptyState
              round
              icon={SearchX}
              title={search ? `No encontramos “${search}”` : "No hay materiales con ese filtro"}
              description="Prueba con otro nombre o quita el filtro de rubro. Los materiales nuevos aparecen al registrar un pedido."
              actions={
                <Button variant="secondary" icon={X} onClick={clear}>
                  Limpiar búsqueda
                </Button>
              }
              className="py-8"
            />
            {suggestions.length ? (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-fg-3">Quizás buscabas</span>
                <div className="overflow-hidden rounded-[14px] border border-border bg-surface">
                  {suggestions.map((m, i) => (
                    <button key={m.id} type="button" onClick={() => open(m)} className={cn("flex w-full items-center gap-3 px-4 py-3 text-left", i > 0 && "border-t border-border")}>
                      <span className="flex flex-1 flex-col gap-0.5">
                        <span className="text-[15px] font-medium text-fg">{m.name}</span>
                        <span className="font-mono text-xs text-fg-3">
                          pedido {formatNumber(m.ordered)}
                          {m.computation ? ` de ${formatNumber(m.computation.expected)}` : ""} {m.unit}
                        </span>
                      </span>
                      <ChevronRight size={16} className="text-fg-3" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : loaded ? (
        <>
          <div className="hidden overflow-hidden rounded-[14px] border border-border bg-surface lg:block">
            <div className="flex h-10 items-center gap-3 bg-sunken px-5 text-xs font-medium text-fg-3">
              <span className="flex-1">Material</span>
              <span className="w-[72px] text-right">Cómputo</span>
              <span className="w-[80px] text-right">Pedido</span>
              <span className="w-[86px] text-right">Entregado</span>
              <span className="w-[150px] pl-4">% del cómputo pedido</span>
              <span className="w-[72px] text-right">Restante</span>
              <span className="w-[100px] text-right">Variación</span>
              <span className="w-[150px] text-right">Indicador</span>
            </div>
            {filtered.map((m) => {
              const s = statusOf(m);
              const c = m.computation;
              return (
                <button key={m.id} type="button" onClick={() => open(m)} className={cn("flex h-[58px] w-full items-center gap-3 border-t border-border px-5 text-left transition-colors hover:bg-sunken", s === "supera" && "bg-sunken")}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-fg">{m.name}</span>
                    <span className="truncate text-xs text-fg-3">
                      {m.unit} · {m.supplierName}
                    </span>
                  </span>
                  <span className="w-[72px] text-right font-mono text-[13px] text-fg-2">{c ? formatNumber(c.expected) : "—"}</span>
                  <span className="w-[80px] text-right font-mono text-[13px] font-semibold text-fg">{formatNumber(m.ordered)}</span>
                  <span className={cn("w-[86px] text-right font-mono text-[13px]", m.delivered < m.ordered ? "text-info" : "text-fg-2")}>{formatNumber(m.delivered)}</span>
                  <span className="flex w-[150px] items-center gap-2.5 pl-4">
                    {c ? (
                      <>
                        <ComputationBar percent={c.percent} tone={barTone(s)} className="w-[72px] shrink-0" />
                        <span className={cn("font-mono text-[13px]", pctColor(s))}>{c.percent}%</span>
                      </>
                    ) : (
                      <span className="text-[13px] text-fg-3">Sin cómputo</span>
                    )}
                  </span>
                  <span className="w-[72px] text-right font-mono text-[13px] text-fg">{c ? formatNumber(c.remaining) : "—"}</span>
                  <span className={cn("w-[100px] text-right font-mono text-[13px]", c && c.variation > 0 ? "text-danger" : "text-fg-3")}>
                    {c && c.variation > 0 ? `+${formatNumber(c.variation)} (+${c.percent - 100}%)` : c && s === "alcanzado" ? "0" : "–"}
                  </span>
                  <span className="flex w-[150px] justify-end">
                    {s === "supera" ? (
                      <Pill tag="computo_supera" />
                    ) : s === "cerca" ? (
                      <Pill tag="computo_cerca" />
                    ) : s === "alcanzado" ? (
                      <Pill tag="computo_alcanzado" />
                    ) : (
                      <span className="text-xs text-fg-3">{STATUS_LABEL[s]}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mx-5 overflow-hidden rounded-[14px] border border-border bg-surface lg:hidden">
            {filtered.map((m, i) => {
              const s = statusOf(m);
              const c = m.computation;
              return (
                <button key={m.id} type="button" onClick={() => open(m)} className={cn("flex w-full flex-col gap-2.5 px-4 py-3.5 text-left", i > 0 && "border-t border-border")}>
                  <span className="flex min-h-6 items-center justify-between gap-2">
                    <span className="text-[15px] font-medium text-fg">{m.name.replace(/ 12x18x33$/, " 12x18x33")}</span>
                    {s === "supera" ? <Pill tag="computo_supera" /> : s === "cerca" ? <Pill tag="computo_cerca" /> : s === "alcanzado" ? <Pill tag="computo_alcanzado" /> : s === "sin_computo" ? <span className="text-xs text-fg-3">Sin cómputo</span> : null}
                  </span>
                  {c ? <ComputationBar percent={c.percent} tone={barTone(s)} /> : null}
                  <span className="flex items-center justify-between font-mono text-xs">
                    <span className="text-fg-2">
                      pedido {formatNumber(m.ordered)}
                      {c ? ` de ${formatNumber(c.expected)}` : ""} {m.unit} {c ? <span className={pctColor(s)}>{c.percent}%</span> : null}
                    </span>
                    <span className={m.delivered < m.ordered ? "text-info" : "text-fg-3"}>entregado {formatNumber(m.delivered)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <Footnote className="hidden lg:flex">Restante = cómputo − pedido acumulado. “Cerca del cómputo” se muestra desde el 85%.</Footnote>
        </>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-[14px] border border-border bg-surface lg:block">
            <div className="flex h-10 items-center gap-3 bg-sunken px-5 text-xs font-medium text-fg-3">
              <span className="flex-1">Material</span>
              <span className="w-[130px]">Rubro</span>
              <span className="w-[180px]">Proveedor</span>
              <span className="w-[110px] text-right">Pedido acumulado</span>
              <span className="w-[130px] text-right">Entregado acumulado</span>
              <span className="w-[130px] text-right">Pendiente de entrega</span>
              <span className="w-[100px] text-right">Último pedido</span>
            </div>
            {filtered.map((m) => (
              <button key={m.id} type="button" onClick={() => open(m)} className="flex h-11 w-full items-center gap-3 border-t border-border px-5 text-left hover:bg-sunken">
                <span className="flex-1 truncate text-sm font-medium text-fg">{m.name}</span>
                <span className="w-[130px] truncate text-[13px] text-fg-2">{m.category}</span>
                <span className="w-[180px] truncate text-[13px] text-fg-2">{m.supplierName}</span>
                <Qty value={m.ordered} unit={m.unit} className="w-[110px]" />
                <Qty value={m.delivered} unit={m.unit} className="w-[130px]" />
                <span className="flex w-[130px] items-center justify-end gap-1.5">
                  {m.pendingDelivery > 0 ? (
                    <>
                      <Truck size={14} className="text-info" />
                      <span className="font-mono text-[13px] text-info">
                        {formatNumber(m.pendingDelivery)} {m.unit}
                      </span>
                    </>
                  ) : (
                    <span className="text-fg-3">—</span>
                  )}
                </span>
                <span className="w-[100px] text-right font-mono text-xs text-fg-3">{formatDate(m.lastOrderDate)}</span>
              </button>
            ))}
          </div>
          <div className="mx-5 overflow-hidden rounded-[14px] border border-border bg-surface lg:hidden">
            {filtered.map((m, i) => (
              <button key={m.id} type="button" onClick={() => open(m)} className={cn("flex w-full items-center gap-3 px-4 py-3 text-left", i > 0 && "border-t border-border")}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-medium text-fg">{m.name}</span>
                  {m.pendingDelivery > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-info">
                      <Truck size={12} />
                      {formatNumber(m.pendingDelivery)} {m.unit} por entregar
                    </span>
                  ) : (
                    <span className="truncate text-xs text-fg-3">{m.supplierName}</span>
                  )}
                </span>
                <span className="flex flex-col items-end gap-0.5">
                  <span className="font-mono text-sm font-semibold text-fg">
                    {formatNumber(m.ordered)} <span className="font-sans text-[11px] font-normal text-fg-3">{m.unit}</span>
                  </span>
                  <span className="font-mono text-[11px] text-fg-3">entregado {formatNumber(m.delivered)}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {hiddenInput}
      <ComputationImportSheet preview={preview} onClose={() => setPreview(null)} />
      <Sheet open={exampleOpen} onClose={() => setExampleOpen(false)} title="Ejemplo de cómputo" subtitle="Una fila por material, con unidad y cantidad prevista" size="lg">
        <div className="flex flex-col gap-3 pb-4">
          <div className="overflow-hidden rounded-[10px] border border-border">
            <div className="flex gap-3 bg-sunken px-3.5 py-2 text-xs font-medium text-fg-3">
              <span className="flex-1">Material</span>
              <span className="w-20">Unidad</span>
              <span className="w-24 text-right">Previsto</span>
            </div>
            {[
              ["Hierro Ø12 x 12 m", "barras", "90"],
              ["Hierro Ø10 x 12 m", "barras", "45"],
              ["Cemento portland 50 kg", "bolsas", "300"],
              ["Arena gruesa", "m³", "40"],
              ["Ladrillo hueco 12x18x33", "u", "6.500"],
            ].map(([a, b, c]) => (
              <div key={a} className="flex gap-3 border-t border-border px-3.5 py-2.5 text-sm">
                <span className="flex-1 text-fg">{a}</span>
                <span className="w-20 text-fg-2">{b}</span>
                <span className="w-24 text-right font-mono text-fg">{c}</span>
              </div>
            ))}
          </div>
          <p className="text-[13px] text-fg-3">Acepta planillas .xlsx o .csv con columnas material, unidad y cantidad (opcional: etapa y % de desperdicio). Después de subirla revisas cómo se vinculó cada material con lo ya pedido.</p>
        </div>
      </Sheet>
    </Page>
  );
}

function Qty({ value, unit, className }: { value: number; unit: string; className?: string }) {
  return (
    <span className={cn("text-right font-mono text-[13px] text-fg", className)}>
      {formatNumber(value)} <span className="font-sans text-xs text-fg-3">{unit}</span>
    </span>
  );
}
