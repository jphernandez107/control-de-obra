import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Download, Search, Store, Truck, Wallet } from "lucide-react";
import type { SupplierSummary } from "@/domain/types";
import { formatMoney, pluralize } from "@/domain/format";
import { RegisterPaymentSheet } from "@/components/domain/RecordSheets";
import { DesktopHeader, MobileHeader } from "@/components/layout/MobileHeader";
import { Footnote, Page } from "@/components/layout/Page";
import { Button, IconButton } from "@/components/ui/Button";
import { FilterChip, SearchField, SelectChip } from "@/components/ui/Fields";
import { Pill } from "@/components/ui/Pill";
import { SplitProgress } from "@/components/ui/Progress";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState, ErrorState, LoadingNote, Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useOrders, useSuppliers } from "@/queries";
import { useAssistant } from "@/features/assistant/AssistantProvider";

function normalize(t: string) {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function mobileMeta(s: SupplierSummary) {
  const parts = [s.category];
  if (s.openOrders) parts.push(pluralize(s.openOrders, "abierto"));
  if (s.pendingDeliveries) parts.push(`${s.pendingDeliveries} ${s.pendingDeliveries === 1 ? "entrega pend." : "entregas pend."}`);
  if (!s.openOrders) parts.push("al día");
  return parts.join(" · ");
}

export function SuppliersPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const assistant = useAssistant();
  const { data, isPending, isError, refetch, isRefetching } = useSuppliers();
  const orders = useOrders();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [withBalance, setWithBalance] = useState(false);
  const [withDeliveries, setWithDeliveries] = useState(false);
  const [paySupplier, setPaySupplier] = useState<SupplierSummary | null>(null);
  const [pickOpen, setPickOpen] = useState(false);

  const suppliers = data?.suppliers ?? [];
  const categories = useMemo(() => [...new Set(suppliers.map((s) => s.category))], [suppliers]);
  const filtered = suppliers.filter((s) => {
    const q = normalize(search.trim());
    if (q && !normalize(`${s.name} ${s.category}`).includes(q)) return false;
    if (category && s.category !== category) return false;
    if (withBalance && s.balance <= 0) return false;
    if (withDeliveries && s.pendingDeliveries === 0) return false;
    return true;
  });
  const anyFilter = Boolean(search || category || withBalance || withDeliveries);
  const clear = () => {
    setSearch("");
    setCategory("");
    setWithBalance(false);
    setWithDeliveries(false);
  };
  const open = (s: SupplierSummary) => navigate({ to: "/proveedores/$supplierId", params: { supplierId: s.id } });
  const supplierOrders = (id: string) =>
    (orders.data?.orders ?? []).filter((o) => o.supplier.id === id && (o.pendingPayment ?? 0) > 0).map((o) => ({ id: o.id, number: o.number, pendingPayment: o.pendingPayment, deliveryStatus: o.delivery.status }));

  return (
    <Page>
      <MobileHeader eyebrow="Casa Córdoba" title="Proveedores" actions={<IconButton icon={Search} label="Buscar proveedor" onClick={() => document.getElementById("supplier-search")?.focus()} />} />
      <DesktopHeader
        title="Proveedores"
        subtitle={isPending ? <Skeleton className="h-3.5 w-56" /> : data ? `${pluralize(suppliers.length, "proveedor", "proveedores")} · ${pluralize(data.orderCount, "pedido registrado", "pedidos registrados")}` : undefined}
        actions={
          isPending ? (
            <>
              <Skeleton className="h-11 w-[120px] rounded-[10px]" />
              <Skeleton className="h-11 w-[150px] rounded-[10px]" />
            </>
          ) : (
            <>
              <Button variant="secondary" icon={Download} onClick={() => toast("La exportación estará disponible con el backend", "info")}>
                Exportar
              </Button>
              <Button icon={Wallet} onClick={() => setPickOpen(true)} disabled={!suppliers.length}>
                Registrar pago
              </Button>
            </>
          )
        }
      />

      {isPending ? (
        <SuppliersSkeleton />
      ) : isError ? (
        <ErrorState title="No pudimos cargar los proveedores" onRetry={() => refetch()} retrying={isRefetching} className="flex-1" />
      ) : suppliers.length === 0 ? (
        <EmptyState
          icon={Store}
          title="Todavía no hay proveedores"
          description="Se crean solos cuando registras el primer pedido con el asistente."
          actions={<Button onClick={() => navigate({ to: "/" })}>Ir al asistente</Button>}
          className="flex-1"
        />
      ) : (
        <>
          <div className="hidden py-1 lg:flex [&>*+*]:border-l [&>*+*]:border-border">
            {[
              { label: "Total pedido", value: data!.totalOrdered },
              { label: "Pagado", value: data!.totalPaid },
              { label: "Saldo pendiente", value: data!.totalBalance },
              { label: "Pago sin imputar", value: data!.unallocatedTotal, ai: true },
            ].map((m, i) => (
              <div key={m.label} className={cn("flex flex-1 flex-col gap-1.5", i === 0 ? "pr-6" : "px-6")}>
                <span className="text-[13px] text-fg-3">{m.label}</span>
                <span className={cn("font-mono text-[26px] font-medium tracking-[-0.5px]", m.ai ? "text-ai" : "text-fg")}>{formatMoney(m.value)}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 px-5 pt-1 pb-4 lg:hidden">
            <div className="flex items-end justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[13px] text-fg-3">Saldo pendiente</span>
                <span className="font-mono text-[30px] leading-9 font-semibold tracking-[-1px] text-fg">{formatMoney(data!.totalBalance)}</span>
              </div>
              <div className="flex flex-col items-end gap-0.5 pb-1">
                <span className="text-xs text-fg-3">Pagado</span>
                <span className="font-mono text-sm text-fg-2">{formatMoney(data!.totalPaid)}</span>
              </div>
            </div>
            <SplitProgress
              height={6}
              segments={[
                { value: ((data!.totalPaid - data!.unallocatedTotal) / data!.totalOrdered) * 100, tone: "success" },
                { value: (data!.unallocatedTotal / data!.totalOrdered) * 100, tone: "ai" },
              ]}
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-success" />
                Pagado e imputado
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-ai" />
                Sin imputar {formatMoney(data!.unallocatedTotal)}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-surface-2" />
                Saldo
              </span>
            </div>
            <SearchField id="supplier-search" placeholder="Buscar proveedor o rubro" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} containerClassName="mt-2 h-11" />
          </div>

          <div className="hidden items-center gap-2 lg:flex">
            <SearchField placeholder="Buscar proveedor o rubro" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} containerClassName="w-[320px]" />
            <SelectChip label="Rubro" value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: c }))} allLabel="Todos los rubros" />
            <FilterChip label="Con saldo" active={withBalance} onClick={() => setWithBalance(true)} onRemove={() => setWithBalance(false)} />
            <FilterChip label="Entregas pendientes" active={withDeliveries} onClick={() => setWithDeliveries(true)} onRemove={() => setWithDeliveries(false)} />
            {anyFilter ? (
              <button type="button" onClick={clear} className="ml-1 text-[13px] font-medium text-accent">
                Limpiar filtros
              </button>
            ) : null}
            <span className="flex-1" />
            <span className="text-[13px] text-fg-2">Ordenar: Saldo ↓</span>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No hay proveedores que coincidan"
              description={search ? `Ningún proveedor coincide con «${search}».` : "Prueba quitando algún filtro."}
              actions={
                <Button variant="secondary" onClick={clear}>
                  Quitar filtros
                </Button>
              }
              className="rounded-[14px] lg:border lg:border-border lg:bg-surface"
            />
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-[14px] border border-border bg-surface lg:block">
                <div className="flex h-10 items-center gap-3 bg-sunken px-5 text-xs font-medium text-fg-3">
                  <span className="flex-1">Proveedor</span>
                  <span className="w-[140px]">Rubro</span>
                  <span className="w-[120px] text-right">Total pedidos</span>
                  <span className="w-[120px] text-right">Pagado</span>
                  <span className="w-[120px] text-right">Saldo</span>
                  <span className="w-[100px] text-right">Pedidos abiertos</span>
                  <span className="w-[110px] text-right">Entregas pend.</span>
                  <span className="w-4" />
                </div>
                {filtered.map((s) => (
                  <button key={s.id} type="button" onClick={() => open(s)} className="flex min-h-16 w-full items-center gap-3 border-t border-border px-5 py-3 text-left transition-colors hover:bg-sunken">
                    <span className="flex flex-1 items-center gap-2.5">
                      <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-xs font-semibold text-fg-2">{s.initials}</span>
                      <span className="flex flex-col items-start gap-1">
                        <span className="text-sm font-medium text-fg">{s.name}</span>
                        {s.unallocatedPaid > 0 ? <Pill tag="pago_sin_imputar" className="h-[22px]" /> : s.ordersWithoutDocument > 0 ? <Pill tag="sin_comprobante" className="h-[22px]" /> : null}
                      </span>
                    </span>
                    <span className="w-[140px] text-sm text-fg-2">{s.category}</span>
                    <span className="w-[120px] text-right font-mono text-[13px] text-fg">{formatMoney(s.totalOrdered)}</span>
                    <span className="w-[120px] text-right font-mono text-[13px] text-fg-2">{formatMoney(s.totalPaid)}</span>
                    <span className={cn("w-[120px] text-right font-mono text-[13px]", s.balance > 0 ? "font-semibold text-fg" : "text-fg-3")}>{formatMoney(s.balance)}</span>
                    <span className={cn("w-[100px] text-right font-mono text-[13px]", s.openOrders ? "text-fg" : "text-fg-3")}>{s.openOrders}</span>
                    <span className="flex w-[110px] items-center justify-end gap-1.5 font-mono text-[13px]">
                      {s.pendingDeliveries ? (
                        <>
                          <Truck size={14} className="text-info" />
                          <span className="text-info">{s.pendingDeliveries}</span>
                        </>
                      ) : (
                        <span className="text-fg-3">0</span>
                      )}
                    </span>
                    <ChevronRight size={16} className="w-4 text-fg-3" />
                  </button>
                ))}
              </div>

              <div className="mx-5 overflow-hidden rounded-[14px] border border-border bg-surface lg:hidden">
                {filtered.map((s, i) => (
                  <button key={s.id} type="button" onClick={() => open(s)} className={cn("flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-sunken", i > 0 && "border-t border-border")}>
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="text-[15px] font-medium text-fg">{s.name}</span>
                      <span className="text-[13px] text-fg-3">{mobileMeta(s)}</span>
                      {s.unallocatedPaid > 0 ? <Pill tag="pago_sin_imputar" className="mt-1" /> : s.ordersWithoutDocument > 0 ? <Pill tag="sin_comprobante" className="mt-1" /> : null}
                    </span>
                    <span className="flex flex-col items-end gap-0.5">
                      <span className={cn("font-mono text-[15px] font-semibold", s.balance > 0 ? "text-fg" : "text-fg-3")}>{formatMoney(s.balance)}</span>
                      <span className="text-xs text-fg-3">saldo</span>
                    </span>
                    <ChevronRight size={16} className="text-fg-3" />
                  </button>
                ))}
              </div>
            </>
          )}
          <Footnote className="hidden lg:flex">El saldo es total pedido menos pagado. Los pagos sin imputar ya descuentan del saldo del proveedor.</Footnote>
        </>
      )}

      <PickSupplierSheet
        open={pickOpen}
        suppliers={suppliers}
        onClose={() => setPickOpen(false)}
        onPick={(s) => {
          setPickOpen(false);
          setPaySupplier(s);
        }}
      />
      {paySupplier ? (
        <RegisterPaymentSheet
          open
          onClose={() => setPaySupplier(null)}
          today={assistant.today}
          supplier={paySupplier}
          balance={paySupplier.balance}
          orders={supplierOrders(paySupplier.id)}
        />
      ) : null}
    </Page>
  );
}


function PickSupplierSheet({ open, suppliers, onClose, onPick }: { open: boolean; suppliers: SupplierSummary[]; onClose: () => void; onPick: (s: SupplierSummary) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Registrar pago" subtitle="¿A qué proveedor?">
      <div className="flex flex-col pb-4">
        {suppliers.map((s) => (
          <button key={s.id} type="button" onClick={() => onPick(s)} className="flex items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-sunken">
            <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-xs font-semibold text-fg-2">{s.initials}</span>
            <span className="flex-1 text-sm font-medium text-fg">{s.name}</span>
            <span className={cn("font-mono text-[13px]", s.balance > 0 ? "text-fg" : "text-fg-3")}>{formatMoney(s.balance)}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function SuppliersSkeleton() {
  return (
    <>
      <div className="hidden gap-0 lg:flex [&>*+*]:border-l [&>*+*]:border-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={cn("flex flex-1 flex-col gap-3", i === 0 ? "pr-6" : "px-6")}>
            <Skeleton className="h-3 w-[90px]" />
            <Skeleton className="h-6 w-[160px]" />
          </div>
        ))}
      </div>
      <div className="hidden gap-2 lg:flex">
        <Skeleton className="h-10 w-[320px] rounded-[10px]" />
        <Skeleton className="h-8 w-[90px] rounded-2xl" />
        <Skeleton className="h-8 w-[100px] rounded-2xl" />
      </div>
      <div className="mx-5 overflow-hidden rounded-[14px] border border-border bg-surface lg:mx-0">
        <div className="hidden h-9 bg-sunken lg:block" />
        {[180, 140, 160, 120, 150, 130].map((w, i) => (
          <div key={i} className="flex h-16 items-center gap-3 border-t border-border px-5 first:border-t-0 lg:first:border-t">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-2.5" style={{ width: w }} />
              <Skeleton className="h-2 w-[90px]" />
            </div>
            <Skeleton className="hidden h-2.5 w-[100px] lg:block" />
            <Skeleton className="hidden h-2.5 w-[100px] lg:block" />
            <Skeleton className="h-2.5 w-[80px]" />
          </div>
        ))}
      </div>
      <div className="px-5 lg:px-0">
        <LoadingNote>Cargando proveedores y saldos…</LoadingNote>
      </div>
    </>
  );
}
