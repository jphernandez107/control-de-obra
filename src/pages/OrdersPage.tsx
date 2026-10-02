import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Camera, CircleHelp, ClipboardList, Download, FileX, Paperclip, Search, Sparkles } from "lucide-react";
import type { OrderSummary } from "@/domain/types";
import { formatDate, formatMoney, formatShortDate, pluralize } from "@/domain/format";
import { DeliveryCell, MiniStatuses, PaymentCell } from "@/components/domain/OrderStatus";
import { Footnote, Kpi, KpiStrip, Page, SegmentChip } from "@/components/layout/Page";
import { DesktopHeader, MobileHeader } from "@/components/layout/MobileHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { FilterChip, SearchField, SelectChip } from "@/components/ui/Fields";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useOrders } from "@/queries";
import { fileToAttachment, useAssistant } from "@/features/assistant/AssistantProvider";

type Segment = "todos" | "por_entregar" | "con_saldo" | "sin_comprobante";
type DateRange = "7" | "30" | "mes";

function normalize(t: string) {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function daysBefore(date: string, days: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function OrdersPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const assistant = useAssistant();
  const { data, isPending, isError, refetch, isRefetching, dataUpdatedAt, errorUpdatedAt } = useOrders();
  const [search, setSearch] = useState("");
  const [supplier, setSupplier] = useState("");
  const [delivery, setDelivery] = useState<"" | OrderSummary["delivery"]["status"]>("");
  const [payment, setPayment] = useState<"" | OrderSummary["payment"]["status"]>("");
  const [range, setRange] = useState<"" | DateRange>("");
  const [noDoc, setNoDoc] = useState(false);
  const [segment, setSegment] = useState<Segment>("todos");
  const [mobileSearch, setMobileSearch] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  const orders = data?.orders ?? [];
  const today = assistant.today || orders[0]?.date || "";
  const suppliers = useMemo(() => [...new Map(orders.map((o) => [o.supplier.id, o.supplier])).values()], [orders]);

  const segmentMatch = (o: OrderSummary, s: Segment) =>
    s === "todos" || (s === "por_entregar" && o.delivery.status !== "entregado") || (s === "con_saldo" && (o.pendingPayment ?? 0) > 0) || (s === "sin_comprobante" && !o.hasDocument);

  const filtered = orders.filter((o) => {
    const q = normalize(search.trim());
    if (q && !normalize(`${o.number} ${o.supplier.name} ${o.itemsLabel} ${o.materialNames.join(" ")}`).includes(q)) return false;
    if (supplier && o.supplier.id !== supplier) return false;
    if (delivery && o.delivery.status !== delivery) return false;
    if (payment && o.payment.status !== payment) return false;
    if (noDoc && o.hasDocument) return false;
    if (range && today) {
      const from = range === "mes" ? `${today.slice(0, 7)}-01` : daysBefore(today, Number(range));
      if (o.date < from) return false;
    }
    return true;
  });
  const mobileList = filtered.filter((o) => segmentMatch(o, segment));
  const anyFilter = Boolean(search || supplier || delivery || payment || range || noDoc);
  const clearFilters = () => {
    setSearch("");
    setSupplier("");
    setDelivery("");
    setPayment("");
    setRange("");
    setNoDoc(false);
    setSegment("todos");
  };

  const open = (o: OrderSummary) => navigate({ to: "/pedidos/$orderId", params: { orderId: o.id } });
  const goAssistant = () => navigate({ to: "/" });

  const noResultsDescription = () => {
    const parts: string[] = [];
    const supplierName = suppliers.find((s) => s.id === supplier)?.name;
    let text = "Ningún pedido";
    if (supplierName) text += ` de ${supplierName}`;
    if (delivery) parts.push({ pendiente: "pendiente de entrega", parcial: "con entrega parcial", entregado: "entregado" }[delivery]);
    if (payment) parts.push({ sin_pagos: "sin pagos", parcial: "con pago parcial", pagado: "pagado" }[payment]);
    if (noDoc) parts.push("sin comprobante");
    if (parts.length) text += ` ${parts.join(", ")}`;
    return search ? `${text} incluye «${search}».` : `${text} coincide con los filtros.`;
  };

  const unallocatedNote =
    data && data.unallocatedTotal > 0
      ? `El pendiente de pago se calcula por pedido. ${data.unallocatedSuppliers.join(", ")} además ${data.unallocatedSuppliers.length > 1 ? "tienen" : "tiene"} ${formatMoney(data.unallocatedTotal)} en pagos sin imputar, que ya descuentan del saldo del proveedor.`
      : "El pendiente de pago se calcula por pedido: total menos los pagos imputados a ese pedido.";

  const errorStamp = errorUpdatedAt ? `Último intento ${formatDate(today)} ${new Date(errorUpdatedAt).toTimeString().slice(0, 5)} · código 503` : undefined;
  void dataUpdatedAt;

  const desktopFilters = (
    <div className="hidden items-center gap-2 lg:flex">
      <SearchField placeholder="Buscar pedido, proveedor o material" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} containerClassName="w-[300px]" />
      <SelectChip label="Proveedor" value={supplier} onChange={setSupplier} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} allLabel="Todos los proveedores" />
      <SelectChip
        label="Entrega"
        value={delivery}
        onChange={setDelivery}
        options={[
          { value: "pendiente", label: "Pendiente de entrega" },
          { value: "parcial", label: "Entrega parcial" },
          { value: "entregado", label: "Entregado" },
        ]}
      />
      <SelectChip
        label="Pago"
        value={payment}
        onChange={setPayment}
        options={[
          { value: "sin_pagos", label: "Sin pagos" },
          { value: "parcial", label: "Pago parcial" },
          { value: "pagado", label: "Pagado" },
        ]}
      />
      <SelectChip
        label="Fecha"
        value={range}
        onChange={setRange}
        options={[
          { value: "7", label: "Últimos 7 días" },
          { value: "30", label: "Últimos 30 días" },
          { value: "mes", label: "Este mes" },
        ]}
      />
      <FilterChip label="Sin comprobante" active={noDoc} onClick={() => setNoDoc(true)} onRemove={() => setNoDoc(false)} dropdown={false} icon={noDoc ? undefined : <FileX size={14} className="text-fg-3" />} />
      {anyFilter ? (
        <button type="button" onClick={clearFilters} className="ml-1 text-[13px] font-medium text-accent">
          Limpiar filtros
        </button>
      ) : null}
      <span className="flex-1" />
      <span className="text-[13px] text-fg-3">Más recientes primero</span>
    </div>
  );

  let body: React.ReactNode;
  if (isPending) {
    body = <OrdersSkeleton />;
  } else if (isError) {
    body = (
      <div className="rounded-[10px] lg:border lg:border-border">
        <ErrorState title="No pudimos cargar los pedidos" onRetry={() => refetch()} retrying={isRefetching} stamp={errorStamp} className="py-24" />
      </div>
    );
  } else if (orders.length === 0) {
    body = (
      <div className="rounded-[10px] lg:border lg:border-border">
        <EmptyState
          icon={ClipboardList}
          title="Todavía no hay pedidos"
          description="Cuéntale al asistente qué se pidió o envíale la foto del comprobante. El pedido y el proveedor se crean solos."
          actions={
            <Button icon={Sparkles} onClick={goAssistant}>
              Registrar con el asistente
            </Button>
          }
          className="py-24"
        />
      </div>
    );
  } else {
    body = (
      <>
        <div className="hidden overflow-hidden rounded-[10px] border border-border lg:block">
          {filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No hay pedidos que coincidan"
              description={noResultsDescription()}
              className="py-36"
              actions={
                <>
                  <Button variant="secondary" icon={CircleHelp} onClick={clearFilters}>
                    Quitar filtros
                  </Button>
                  <Button variant="ghost" icon={Sparkles} onClick={() => assistant.send({ text: search ? `¿Qué pedidos incluyen ${search}?` : "¿Qué pedidos siguen pendientes de entrega?" }).then(goAssistant)}>
                    Preguntar al asistente
                  </Button>
                </>
              }
            />
          ) : (
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-sunken text-xs font-medium text-fg-3">
                  <th className="w-[80px] py-2.5 pl-4 font-medium">N.º</th>
                  <th className="px-3.5 font-medium">Proveedor</th>
                  <th className="w-[106px] px-3.5 font-medium">Fecha</th>
                  <th className="w-[182px] px-3.5 font-medium">Entrega</th>
                  <th className="w-[182px] px-3.5 font-medium">Pago</th>
                  <th className="w-[134px] px-3.5 text-right font-medium">Total</th>
                  <th className="w-[146px] px-3.5 text-right font-medium">Pendiente de pago</th>
                  <th className="w-[58px] pr-4" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr key={o.id} onClick={() => open(o)} className="h-[60px] cursor-pointer border-t border-border transition-colors hover:bg-sunken">
                    <td className="pl-4 font-mono text-sm font-semibold text-fg">
                      <a href={`/pedidos/${o.id}`} onClick={(e) => e.preventDefault()} className="outline-none">
                        {o.number}
                      </a>
                    </td>
                    <td className="px-3.5">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-fg">{o.supplier.name}</span>
                        <span className="text-xs text-fg-3">{o.itemsLabel}</span>
                      </div>
                    </td>
                    <td className="px-3.5 font-mono text-[13px] text-fg-2">{formatDate(o.date)}</td>
                    <td className="px-3.5">
                      <DeliveryCell order={o} />
                    </td>
                    <td className="px-3.5">
                      <PaymentCell order={o} />
                    </td>
                    <td className="px-3.5 text-right">
                      {o.total === null ? <span className="text-[13px] text-fg-3">A confirmar</span> : <span className="font-mono text-sm text-fg">{formatMoney(o.total)}</span>}
                    </td>
                    <td className="px-3.5 text-right">
                      {o.pendingPayment === null ? (
                        <span className="text-fg-3">—</span>
                      ) : o.pendingPayment === 0 ? (
                        <span className="font-mono text-sm text-fg-3">$0</span>
                      ) : (
                        <span className="font-mono text-sm font-semibold text-fg">{formatMoney(o.pendingPayment)}</span>
                      )}
                    </td>
                    <td className="pr-4 text-center">
                      {o.hasDocument ? (
                        <Paperclip size={16} className="inline text-fg-3" aria-label="Con comprobante" />
                      ) : (
                        <FileX size={16} className="inline text-warning" aria-label="Sin comprobante" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-t border-border bg-surface lg:hidden">
          {mobileList.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No hay pedidos que coincidan"
              description={search ? `Ningún pedido incluye «${search}».` : "Prueba con otro filtro."}
              actions={
                <Button variant="secondary" onClick={clearFilters}>
                  Quitar filtros
                </Button>
              }
            />
          ) : (
            mobileList.map((o) => (
              <button key={o.id} type="button" onClick={() => open(o)} className="flex w-full flex-col gap-2.5 border-b border-border px-4 py-3.5 text-left active:bg-sunken">
                <span className="flex w-full gap-2.5">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[15px] font-semibold text-fg">{o.number}</span>
                      <span className="truncate text-[15px] font-medium text-fg">{o.supplier.name}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-fg-3">
                      <span className="font-mono">{formatShortDate(o.date)}</span>
                      {!o.hasDocument ? (
                        <>
                          <span>·</span>
                          <FileX size={12} className="text-warning" />
                          <span className="text-warning">Sin comprobante</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-0.5">
                    <span className={cn("font-mono text-sm font-medium text-fg", o.total === null && "font-sans text-[13px] text-fg-3")}>{o.total === null ? "Sin importe" : formatMoney(o.total)}</span>
                    {o.pendingPayment === null ? (
                      <span className="text-xs text-fg-3">a confirmar</span>
                    ) : o.pendingPayment > 0 ? (
                      <span className="font-mono text-xs font-semibold text-warning">Debe {formatMoney(o.pendingPayment)}</span>
                    ) : (
                      <span className="font-mono text-xs text-fg-3">Saldado</span>
                    )}
                  </span>
                </span>
                <MiniStatuses order={o} />
              </button>
            ))
          )}
          <Footnote className="px-4 py-4">{unallocatedNote}</Footnote>
        </div>
      </>
    );
  }

  return (
    <Page surface>
      <MobileHeader
        eyebrow={`Casa Córdoba${data ? ` · ${pluralize(orders.length, "pedido")}` : ""}`}
        title="Pedidos"
        actions={<IconButton icon={Search} label="Buscar pedidos" onClick={() => setMobileSearch((v) => !v)} />}
      />
      <DesktopHeader
        title="Pedidos"
        subtitle={
          data && orders.length ? (
            <span className="text-fg-3">
              {pluralize(orders.length, "pedido")} · {pluralize(data.supplierCount, "proveedor", "proveedores")}
              {data.firstOrderDate ? ` · desde ${formatDate(data.firstOrderDate)}` : ""}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button variant="secondary" icon={Download} onClick={() => toast("La exportación estará disponible con el backend", "info")}>
              Exportar
            </Button>
            <Button icon={Sparkles} onClick={goAssistant}>
              Registrar con el asistente
            </Button>
          </>
        }
      />
      {data && orders.length > 0 ? (
        <KpiStrip>
          <Kpi label="Total pedido" value={formatMoney(data.totalOrdered)} sub={`${pluralize(orders.length, "pedido")}${data.unknownValueCount ? ` · ${data.unknownValueCount} sin importe` : ""}`} />
          <Kpi label="Pendiente de entrega" dot="bg-info" value={pluralize(data.pendingDeliveryCount, "pedido")} sub={data.pendingDeliveryLabel} />
          <Kpi label="Pendiente de pago" dot="bg-warning" value={formatMoney(data.pendingPaymentTotal)} sub={`en ${pluralize(data.pendingPaymentCount, "pedido")}`} />
          <Kpi label="Pagos sin imputar" dot="bg-ai" value={formatMoney(data.unallocatedTotal)} sub={data.unallocatedSuppliers.join(", ") || "Ninguno"} />
        </KpiStrip>
      ) : null}
      {orders.length > 0 ? desktopFilters : null}

      {orders.length > 0 ? (
        <div className="flex flex-col gap-3 lg:hidden">
          {mobileSearch ? (
            <div className="px-4 pt-1">
              <SearchField autoFocus placeholder="Buscar pedido, proveedor o material" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} containerClassName="h-11" />
            </div>
          ) : null}
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pt-1 pb-3">
            {(
              [
                ["todos", "Todos"],
                ["por_entregar", "Por entregar"],
                ["con_saldo", "Con saldo"],
                ["sin_comprobante", "Sin comprobante"],
              ] as [Segment, string][]
            ).map(([id, label]) => (
              <SegmentChip key={id} label={label} count={filtered.filter((o) => segmentMatch(o, id)).length} active={segment === id} onClick={() => setSegment(id)} />
            ))}
          </div>
        </div>
      ) : null}

      {body}
      {data && orders.length > 0 ? <Footnote className="hidden lg:flex">{unallocatedNote}</Footnote> : null}

      {data && orders.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => photoRef.current?.click()}
            className="fixed right-4 bottom-[100px] z-20 inline-flex h-[52px] items-center gap-2 rounded-[26px] bg-accent px-[18px] text-[15px] font-semibold text-on-accent shadow-fab lg:hidden"
          >
            <Camera size={20} />
            Foto
          </button>
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              void assistant.send({ attachments: [fileToAttachment(file)] });
              goAssistant();
            }}
          />
        </>
      ) : null}
    </Page>
  );
}

function OrdersSkeleton() {
  const widths = [180, 150, 200, 170, 140, 190, 160];
  return (
    <>
      <div className="hidden overflow-hidden rounded-[10px] border border-border lg:block">
        <div className="h-[38px] bg-sunken" />
        {widths.map((w, i) => (
          <div key={i} className="flex h-[59px] items-center gap-6 border-t border-border px-4">
            <Skeleton className="h-2.5 w-11" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-2.5" style={{ width: w }} />
              <Skeleton className="h-2 w-[90px]" />
            </div>
            <Skeleton className="h-2.5 w-[150px]" />
            <Skeleton className="h-2.5 w-[150px]" />
            <Skeleton className="h-2.5 w-[90px]" />
            <Skeleton className="h-2.5 w-[100px]" />
          </div>
        ))}
      </div>
      <div className="flex flex-col border-t border-border bg-surface lg:hidden">
        {widths.slice(0, 6).map((w, i) => (
          <div key={i} className="flex flex-col gap-3 border-b border-border px-4 py-4">
            <div className="flex justify-between">
              <Skeleton className="h-3" style={{ width: w }} />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-2.5 w-56" />
          </div>
        ))}
      </div>
    </>
  );
}
