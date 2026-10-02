import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Check, ChevronRight, ClipboardList, Coins, Ellipsis, FileText, Link2, Plus, Store, Truck, Wallet } from "lucide-react";
import type { DocumentRef, LedgerEntry, SupplierDetail } from "@/domain/types";
import { formatDate, formatMoney, formatNumber, pluralize } from "@/domain/format";
import { AllocateSheet } from "@/components/domain/AllocateSheet";
import { DocumentPreview } from "@/components/domain/DocumentPreview";
import { RegisterDeliverySheet, RegisterPaymentSheet } from "@/components/domain/RecordSheets";
import { Breadcrumb, MobileHeader } from "@/components/layout/MobileHeader";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { DocKindIcon, documentKindLabel } from "@/components/ui/DocChip";
import { Pill, deliveryTag, paymentTag } from "@/components/ui/Pill";
import { Progress, SplitProgress } from "@/components/ui/Progress";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useOrder, useSupplier } from "@/queries";
import { useAssistant } from "@/features/assistant/AssistantProvider";
import { csvMoney, downloadCsv } from "@/lib/csv";

export function SupplierDetailPage() {
  const { supplierId } = useParams({ from: "/proveedores/$supplierId" });
  const navigate = useNavigate();
  const toast = useToast();
  const assistant = useAssistant();
  const { data: s, isPending, isError, error, refetch, isRefetching } = useSupplier(supplierId);
  const [preview, setPreview] = useState<DocumentRef | null>(null);
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [deliveryOrderId, setDeliveryOrderId] = useState<string | null>(null);

  if (isPending) return <SupplierSkeleton />;
  if (isError || !s) {
    return error?.name === "NotFoundError" ? (
      <EmptyState icon={Store} title="No encontramos este proveedor" actions={<Link to="/proveedores" className="text-sm font-medium text-accent">Ver proveedores</Link>} className="flex-1" />
    ) : (
      <ErrorState title="No pudimos cargar el proveedor" onRetry={() => refetch()} retrying={isRefetching} className="flex-1" />
    );
  }

  const unallocated = s.unallocatedPayments[0];
  const newOrder = () => {
    assistant.setDraft(`Pedimos a ${s.name} `);
    navigate({ to: "/" });
  };
  const paymentOrders = s.openOrderList.filter((o) => (o.pendingPayment ?? 0) > 0).map((o) => ({ id: o.id, number: o.number, pendingPayment: o.pendingPayment, deliveryStatus: o.delivery.status }));
  const subtitle = [s.category, s.contactName, s.phone, pluralize(s.openOrderList.length, "pedido abierto", "pedidos abiertos")].filter(Boolean).join(" · ");
  const pct = (v: number) => (s.totalOrdered ? (v / s.totalOrdered) * 100 : 0);

  return (
    <div className="flex flex-1 flex-col pb-8 lg:gap-5 lg:px-10 lg:pt-8 lg:pb-10">
      <MobileHeader
        back={{ to: "/proveedores", label: "Proveedores" }}
        title={s.name}
        actions={<IconButton icon={Ellipsis} label="Más acciones" onClick={() => toast("Contacto: " + (s.phone ?? "sin teléfono"), "info")} />}
      />

      <div className="hidden flex-col gap-5 lg:flex">
        <Breadcrumb items={[{ label: "Proveedores", to: "/proveedores" }, { label: s.name }]} />
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-[28px] font-semibold tracking-[-0.6px] text-fg">{s.name}</h1>
            <p className="text-sm text-fg-2">{subtitle}</p>
          </div>
          <Button variant="secondary" icon={Plus} onClick={newOrder}>
            Registrar pedido
          </Button>
          <Button icon={Wallet} onClick={() => setPaymentOpen(true)}>
            Registrar pago
          </Button>
        </div>
      </div>

      {/* Account summary */}
      <div className="hidden flex-col gap-[18px] rounded-[14px] border border-border bg-surface p-6 lg:flex">
        <div className="flex items-end">
          <Figure label="Total pedidos" value={formatMoney(s.totalOrdered)} className="w-[220px]" />
          <Figure label="Pagado" value={formatMoney(s.totalPaid)} className="w-[220px] border-l border-border pl-6" />
          <div className="flex flex-1 flex-col gap-1 border-l border-border pl-6">
            <span className="text-[13px] text-fg-3">Saldo</span>
            <span className="font-mono text-4xl font-semibold tracking-[-0.6px] text-fg">{formatMoney(s.balance)}</span>
          </div>
        </div>
        <SplitProgress height={8} segments={[{ value: pct(s.allocatedPaid), tone: "success" }, { value: pct(s.unallocatedPaid), tone: "ai" }]} />
        <div className="flex flex-wrap items-center gap-5 text-[13px]">
          <Legend dot="bg-success" label="Pagos imputados" value={formatMoney(s.allocatedPaid)} />
          {s.unallocatedPaid > 0 ? <Legend dot="bg-ai" label="Pago sin imputar" value={formatMoney(s.unallocatedPaid)} /> : null}
          <Legend dot="bg-surface-2 border border-border-strong" label="Saldo" value={formatMoney(s.balance)} />
        </div>
        {s.unknownValueOrders ? (
          <p className="text-[13px] text-warning">
            {s.unknownValueOrders === 1 ? "1 pedido no tiene importe cargado" : `${s.unknownValueOrders} pedidos no tienen importe cargado`}: no suma al total y el saldo real puede ser mayor.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 px-5 pb-5 lg:hidden">
        <span className="text-[13px] text-fg-3">Saldo</span>
        <span className="font-mono text-[34px] leading-10 font-semibold tracking-[-1px] text-fg">{formatMoney(s.balance)}</span>
        <div className="flex gap-6">
          <Figure label="Total pedidos" value={formatMoney(s.totalOrdered)} small />
          <Figure label="Pagado" value={formatMoney(s.totalPaid)} small />
        </div>
        <SplitProgress height={6} segments={[{ value: pct(s.allocatedPaid), tone: "success" }, { value: pct(s.unallocatedPaid), tone: "ai" }]} />
        {s.unknownValueOrders ? (
          <p className="text-[13px] text-warning">
            {s.unknownValueOrders === 1 ? "1 pedido no tiene importe cargado" : `${s.unknownValueOrders} pedidos no tienen importe cargado`}: no suma al total y el saldo real puede ser mayor.
          </p>
        ) : null}
      </div>

      {unallocated ? (
        <>
          <div className="hidden items-center gap-4 rounded-[14px] bg-ai-soft px-5 py-4 lg:flex">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-surface text-ai">
              <Coins size={20} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="flex items-center gap-2.5">
                <span className="text-[15px] font-semibold text-fg">Pago sin imputar</span>
                <span className="font-mono text-[15px] font-semibold text-ai">{formatMoney(unallocated.amount)}</span>
                <span className="font-mono text-[13px] text-fg-2">{formatDate(unallocated.date)}</span>
              </span>
              <span className="text-[13px] text-fg-2">Transferencia recibida que todavía no está asignada a ningún pedido. Ya descuenta del saldo del proveedor.</span>
            </div>
            {unallocated.document ? (
              <button type="button" onClick={() => setPreview(unallocated.document!)} className="flex h-[52px] items-center gap-2.5 rounded-[10px] border border-border bg-surface pr-3.5 pl-2.5 text-left hover:bg-sunken">
                <span className="flex size-8 items-center justify-center rounded-md bg-surface-2 text-fg-2">
                  <FileText size={16} />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-fg">{unallocated.document.fileName}</span>
                  <span className="text-xs text-fg-3">Comprobante de pago · {unallocated.document.sizeLabel}</span>
                </span>
              </button>
            ) : null}
            <Button variant="ai" icon={Link2} onClick={() => setAllocateOpen(true)}>
              Imputar a un pedido
            </Button>
          </div>
          <div className="mx-5 mb-6 flex flex-col gap-3 rounded-[14px] bg-ai-soft p-4 lg:hidden">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-surface text-ai">
                <Coins size={18} />
              </span>
              <div className="flex flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-semibold text-fg">Pago sin imputar</span>
                <span className="text-xs text-fg-2">Recibido {formatDate(unallocated.date)} · Transferencia</span>
              </div>
              <span className="font-mono text-base font-semibold text-ai">{formatMoney(unallocated.amount)}</span>
            </div>
            <p className="text-[13px] leading-[19px] text-fg-2">Ya descuenta del saldo. Asígnalo a un pedido para saber qué queda pendiente en cada uno.</p>
            <Button variant="ai" icon={Link2} size="lg" className="w-full" onClick={() => setAllocateOpen(true)}>
              Imputar a un pedido
            </Button>
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-6 lg:gap-4">
          <section className="flex flex-col gap-3 px-5 lg:px-0">
            <div className="flex items-center gap-2">
              <h2 className="flex-1 text-base font-semibold tracking-[-0.2px] text-fg">Pedidos abiertos</h2>
              <Link to="/pedidos" className="hidden text-[13px] font-medium text-accent lg:inline">
                Ver todos los pedidos
              </Link>
              <span className="font-mono text-[13px] text-accent lg:hidden">{s.openOrderList.length}</span>
            </div>
            {s.openOrderList.length === 0 ? (
              <p className="rounded-[14px] border border-border bg-surface px-4 py-5 text-sm text-fg-3">No hay pedidos abiertos. Todo está entregado y pagado.</p>
            ) : (
              <div className="overflow-hidden rounded-[14px] border border-border bg-surface">
                {s.openOrderList.map((o, i) => (
                  <Link key={o.id} to="/pedidos/$orderId" params={{ orderId: o.id }} className={cn("flex items-center gap-4 px-4 py-4 hover:bg-sunken lg:px-5", i > 0 && "border-t border-border")}>
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="flex items-baseline gap-2">
                        <span className="font-mono text-[15px] font-semibold text-fg">Pedido {o.number}</span>
                        <span className="font-mono text-xs text-fg-3">{formatDate(o.date)}</span>
                        <span className="ml-auto flex flex-col items-end lg:hidden">
                          <span className="font-mono text-sm font-semibold text-fg">{o.pendingPayment === null ? "A confirmar" : formatMoney(o.pendingPayment)}</span>
                          <span className="text-xs text-fg-3">pendiente</span>
                        </span>
                      </span>
                      <span className="hidden text-[13px] text-fg-2 lg:block">{o.linesLabel}</span>
                      <span className="flex flex-wrap gap-1.5 pt-0.5">
                        <Pill tag={deliveryTag[o.delivery.status]} />
                        <Pill tag={paymentTag[o.payment.status]} />
                      </span>
                    </span>
                    <span className="hidden w-[100px] flex-col items-end gap-0.5 lg:flex">
                      <span className="text-xs text-fg-3">Total</span>
                      <span className="font-mono text-[13px] text-fg-2">{o.total === null ? "—" : formatMoney(o.total)}</span>
                    </span>
                    <span className="hidden w-[100px] flex-col items-end gap-0.5 lg:flex">
                      <span className="text-xs text-fg-3">Pagado</span>
                      <span className="font-mono text-[13px] text-fg-2">{formatMoney(o.paid)}</span>
                    </span>
                    <span className="hidden w-[100px] flex-col items-end gap-0.5 lg:flex">
                      <span className="text-xs text-fg-3">Pendiente</span>
                      <span className="font-mono text-sm font-semibold text-fg">{o.pendingPayment === null ? "A confirmar" : formatMoney(o.pendingPayment)}</span>
                    </span>
                    <ChevronRight size={16} className="hidden text-fg-3 lg:block" />
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3 px-5 lg:hidden">
            <h2 className="text-base font-semibold text-fg">Entrega pendiente</h2>
            <DeliveryPanel s={s} onRegister={setDeliveryOrderId} compact />
          </section>

          <section className="flex flex-col gap-3 px-5 lg:px-0">
            <div className="flex items-center">
              <h2 className="flex-1 text-base font-semibold tracking-[-0.2px] text-fg">Cuenta corriente</h2>
              <LinkButton className="hidden lg:inline" onClick={() => downloadCsv(`cuenta-corriente-${s.name}.csv`, ["Fecha", "Movimiento", "Detalle", "Pedido", "Pago", "Saldo"], s.ledger.map((e) => [e.date, e.title, e.description, csvMoney(e.orderAmount), csvMoney(e.paymentAmount), csvMoney(e.runningBalance)]))}>
                Exportar
              </LinkButton>
            </div>
            <Ledger entries={s.ledger} balance={s.balance} ordered={s.totalOrdered} paid={s.totalPaid} />
          </section>
        </div>

        <aside className="flex w-full flex-col gap-6 px-5 lg:w-[340px] lg:shrink-0 lg:gap-4 lg:px-0">
          <section className="hidden flex-col gap-3 lg:flex">
            <h2 className="text-base font-semibold tracking-[-0.2px] text-fg">Entregas pendientes</h2>
            <DeliveryPanel s={s} onRegister={setDeliveryOrderId} />
          </section>
          <section className="flex flex-col gap-3 lg:pt-2">
            <div className="flex items-center">
              <h2 className="flex-1 text-base font-semibold tracking-[-0.2px] text-fg">Documentos</h2>
              <span className="font-mono text-[13px] text-accent lg:hidden">{s.documents.length}</span>
              <LinkButton
                className="hidden lg:inline"
                onClick={() => {
                  navigate({ to: "/" });
                  toast("Adjunta el documento en el asistente", "info");
                }}
              >
                Agregar
              </LinkButton>
            </div>
            <div className="flex flex-col gap-2">
              {s.documents.map((d) => (
                <button key={d.id} type="button" onClick={() => setPreview(d)} className="flex h-[52px] items-center gap-2.5 rounded-[10px] border border-border bg-surface pr-3.5 pl-2.5 text-left hover:bg-sunken">
                  <DocKindIcon kind={d.kind} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium text-fg">{d.fileName}</span>
                    <span className="truncate text-xs text-fg-3">
                      {documentKindLabel[d.kind]}
                      {d.kind === "remito" && d.orderNumber ? ` · pedido ${d.orderNumber}` : ""} · {formatDate(d.date)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <DocumentPreview doc={preview} onClose={() => setPreview(null)} />
      <AllocateSheet open={allocateOpen} onClose={() => setAllocateOpen(false)} supplier={s} payment={unallocated} />
      <RegisterPaymentSheet open={paymentOpen} onClose={() => setPaymentOpen(false)} today={assistant.today} supplier={s} balance={s.balance} orders={paymentOrders} />
      {deliveryOrderId ? <DeliverySheetLoader orderId={deliveryOrderId} today={assistant.today} onClose={() => setDeliveryOrderId(null)} /> : null}
    </div>
  );
}

function DeliverySheetLoader({ orderId, today, onClose }: { orderId: string; today: string; onClose: () => void }) {
  const { data } = useOrder(orderId);
  if (!data) return null;
  return <RegisterDeliverySheet order={data} open onClose={onClose} today={today} />;
}

function DeliveryPanel({ s, onRegister, compact }: { s: SupplierDetail; onRegister: (orderId: string) => void; compact?: boolean }) {
  if (s.deliveryOrders.length === 0) {
    return <p className="rounded-[14px] border border-border bg-surface px-4 py-5 text-sm text-fg-3">No hay entregas pendientes.</p>;
  }
  if (compact) {
    return (
      <div className="flex flex-col overflow-hidden rounded-[14px] border border-border bg-surface">
        {s.pendingDeliveryLines.map((l, i) => (
          <Link key={`${l.orderId}-${l.materialName}`} to="/pedidos/$orderId" params={{ orderId: l.orderId }} className={cn("flex flex-col gap-2.5 p-4", i > 0 && "border-t border-border")}>
            <span className="flex items-center justify-between">
              <span className="text-[15px] font-medium text-fg">{l.materialName}</span>
              <span className="font-mono text-sm text-fg-2">
                {formatNumber(l.delivered)} / {formatNumber(l.ordered)}
              </span>
            </span>
            <Progress value={(l.delivered / l.ordered) * 100} tone="info" />
            <span className="text-xs text-fg-3">
              Pedido {l.orderNumber} · faltan {formatNumber(l.ordered - l.delivered)} {l.unit}
            </span>
          </Link>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {s.deliveryOrders.map((o) => (
        <div key={o.orderId} className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-[18px]">
          <div className="flex items-center justify-between">
            <Link to="/pedidos/$orderId" params={{ orderId: o.orderId }} className="font-mono text-sm font-semibold text-fg hover:underline">
              Pedido {o.orderNumber}
            </Link>
            <Pill tag={deliveryTag[o.status]} />
          </div>
          {o.lines.map((l, i) => {
            const done = l.delivered >= l.ordered;
            return (
              <div key={l.materialName} className={cn("flex flex-col gap-2", i > 0 && "border-t border-border pt-3")}>
                <span className="flex items-center justify-between text-sm">
                  <span className="text-fg">{l.materialName}</span>
                  <span className="flex items-center gap-1.5 font-mono text-fg-2">
                    {done ? <Check size={14} className="text-success" /> : null}
                    {formatNumber(l.delivered)} / {formatNumber(l.ordered)}
                  </span>
                </span>
                {!done ? (
                  <>
                    <Progress value={(l.delivered / l.ordered) * 100} tone="info" />
                    <span className="text-xs text-fg-3">
                      Faltan {formatNumber(l.ordered - l.delivered)} {l.unit}
                      {l.lastDeliveryDate ? ` · última entrega ${formatDate(l.lastDeliveryDate)}` : " · todavía sin entregas"}
                    </span>
                  </>
                ) : null}
              </div>
            );
          })}
          <Button variant="secondary" icon={Truck} className="w-full" onClick={() => onRegister(o.orderId)}>
            Registrar entrega
          </Button>
        </div>
      ))}
    </div>
  );
}

function Ledger({ entries, balance, ordered, paid }: { entries: LedgerEntry[]; balance: number; ordered: number; paid: number }) {
  const newestFirst = [...entries].reverse();
  return (
    <>
      <div className="hidden overflow-hidden rounded-[14px] border border-border bg-surface lg:block">
        <div className="flex h-10 items-center gap-3 bg-sunken px-5 text-xs font-medium text-fg-3">
          <span className="w-[96px]">Fecha</span>
          <span className="flex-1">Movimiento</span>
          <span className="w-[110px] text-right">Pedido</span>
          <span className="w-[120px] text-right">Pago</span>
          <span className="w-[120px] text-right">Saldo</span>
        </div>
        {entries.map((e) => (
          <div key={e.id} className="flex min-h-[59px] items-center gap-3 border-t border-border px-5 py-2.5">
            <span className="w-[96px] font-mono text-[13px] text-fg-2">{formatDate(e.date)}</span>
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <LedgerIcon entry={e} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-fg">{e.type === "pedido" ? e.title : "Pago"}</span>
                <span className="truncate text-xs text-fg-3">{e.description}</span>
              </span>
              {e.unallocated ? <Pill tag="pago_sin_imputar" className="ml-auto" /> : null}
            </span>
            <span className="w-[110px] text-right font-mono text-[13px] text-fg">{e.orderAmount !== undefined ? formatMoney(e.orderAmount, { sign: true }) : e.type === "pedido" ? "a confirmar" : "–"}</span>
            <span className={cn("w-[120px] text-right font-mono text-[13px]", e.paymentAmount ? "text-success" : "text-fg-3")}>{e.paymentAmount ? formatMoney(-e.paymentAmount) : "–"}</span>
            <span className="w-[120px] text-right font-mono text-[13px] font-semibold text-fg">{formatMoney(e.runningBalance)}</span>
          </div>
        ))}
        <div className="flex h-12 items-center gap-3 border-t border-border bg-sunken px-5">
          <span className="flex-1 text-sm font-semibold text-fg">Saldo actual</span>
          <span className="w-[110px] text-right font-mono text-[13px] text-fg-2">{formatMoney(ordered)}</span>
          <span className="w-[120px] text-right font-mono text-[13px] text-fg-2">{formatMoney(-paid)}</span>
          <span className="w-[120px] text-right font-mono text-[15px] font-semibold text-fg">{formatMoney(balance)}</span>
        </div>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-border bg-surface lg:hidden">
        {newestFirst.map((e, i) => (
          <div key={e.id} className={cn("flex items-center gap-3 px-4 py-3", i > 0 && "border-t border-border")}>
            <LedgerIcon entry={e} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[15px] font-medium text-fg">{e.title}</span>
              <span className="font-mono text-xs text-fg-3">{formatDate(e.date)}</span>
            </span>
            <span className="flex flex-col items-end gap-0.5">
              <span className={cn("font-mono text-sm font-semibold", e.paymentAmount ? "text-success" : "text-fg")}>
                {e.paymentAmount ? formatMoney(-e.paymentAmount) : e.orderAmount !== undefined ? formatMoney(e.orderAmount, { sign: true }) : "a confirmar"}
              </span>
              <span className="font-mono text-xs text-fg-3">Saldo {formatMoney(e.runningBalance)}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function LedgerIcon({ entry }: { entry: LedgerEntry }) {
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", entry.unallocated ? "bg-ai-soft text-ai" : "bg-surface-2 text-fg-2")}>
      {entry.type === "pedido" ? <ClipboardList size={14} /> : entry.unallocated ? <Coins size={14} /> : <Wallet size={14} />}
    </span>
  );
}

function Figure({ label, value, className, small }: { label: string; value: string; className?: string; small?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className={cn("text-fg-3", small ? "text-xs" : "text-[13px]")}>{label}</span>
      <span className={cn("font-mono font-medium tracking-[-0.6px] text-fg-2", small ? "text-sm" : "text-[22px]")}>{value}</span>
    </div>
  );
}

function Legend({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", dot)} />
      <span className="text-fg-2">{label}</span>
      <span className="font-mono text-fg">{value}</span>
    </span>
  );
}

function SupplierSkeleton() {
  return (
    <div className="flex flex-col gap-5 px-5 py-6 lg:px-10 lg:py-8">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full rounded-[14px]" />
      <div className="flex flex-col gap-4 lg:flex-row">
        <Skeleton className="h-64 flex-1 rounded-[14px]" />
        <Skeleton className="h-64 w-full rounded-[14px] lg:w-[340px]" />
      </div>
    </div>
  );
}
