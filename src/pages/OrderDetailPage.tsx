import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ClipboardList, Coins, Ellipsis, Hourglass, Paperclip, Truck, Wallet } from "lucide-react";
import type { DocumentRef, OrderDetail } from "@/domain/types";
import { formatDate, formatMoney, formatNumber, formatShortDate, paymentMethodLabel, purchaseModeLabel } from "@/domain/format";
import { ActivityItem } from "@/components/domain/ActivityItem";
import { DocumentPreview } from "@/components/domain/DocumentPreview";
import { RegisterDeliverySheet, RegisterPaymentSheet } from "@/components/domain/RecordSheets";
import { BackLink, Breadcrumb } from "@/components/layout/MobileHeader";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { DocChip, documentKindLabel } from "@/components/ui/DocChip";
import { Pill, deliveryTag, paymentTag } from "@/components/ui/Pill";
import { Progress } from "@/components/ui/Progress";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useOrder, useOrders } from "@/queries";
import { useAssistant } from "@/features/assistant/AssistantProvider";

function deliveryTone(o: OrderDetail) {
  return o.delivery.status === "entregado" ? "success" : "info";
}

function deliveryTitle(o: OrderDetail) {
  return { pendiente: "Pendiente de entrega", parcial: "Entrega parcial", entregado: "Entregado" }[o.delivery.status];
}

function paymentTitle(o: OrderDetail) {
  return { sin_pagos: "Sin pagos", parcial: "Pago parcial", pagado: "Pagado" }[o.payment.status];
}

function pendingShort(o: OrderDetail) {
  return o.delivery.pendingLabel?.replace(/^Faltan /, "") ?? "—";
}

export function OrderDetailPage() {
  const { orderId } = useParams({ from: "/pedidos/$orderId" });
  const navigate = useNavigate();
  const toast = useToast();
  const assistant = useAssistant();
  const { data: order, isPending, isError, error, refetch, isRefetching } = useOrder(orderId);
  const orders = useOrders();
  const [preview, setPreview] = useState<DocumentRef | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [savedNotes, setSavedNotes] = useState<string | null>(null);
  const today = assistant.today;

  if (isPending) return <OrderDetailSkeleton />;
  if (isError || !order) {
    const notFound = error?.name === "NotFoundError";
    return notFound ? (
      <EmptyState
        icon={ClipboardList}
        title="No encontramos este pedido"
        description="Puede que se haya deshecho o que el enlace sea incorrecto."
        actions={
          <Link to="/pedidos" className="text-sm font-medium text-accent">
            Ver todos los pedidos
          </Link>
        }
        className="flex-1"
      />
    ) : (
      <ErrorState title="No pudimos cargar el pedido" onRetry={() => refetch()} retrying={isRefetching} className="flex-1" />
    );
  }

  const supplierOrders = (orders.data?.orders ?? []).filter((o) => o.supplier.id === order.supplier.id && ((o.pendingPayment ?? 0) > 0 || o.id === order.id));
  const supplierBalance = (orders.data?.orders ?? []).filter((o) => o.supplier.id === order.supplier.id).reduce((s, o) => s + (o.pendingPayment ?? 0), 0) - order.supplierUnallocated;
  const askToEdit = () => toast("Para corregir, cuéntale al asistente qué cambió", "info");
  const allocateHere = () => {
    void assistant.send({ text: `Imputar el pago sin imputar de ${order.supplier.name} al pedido ${order.number}` });
    navigate({ to: "/" });
  };
  const deliveredPct = order.delivery.ordered ? (order.delivery.delivered / order.delivery.ordered) * 100 : 0;
  const lastDelivery = order.deliveries[0];
  const lastPayment = order.payments[0];
  const docMeta = (d: DocumentRef) => (d.kind === "comprobante_pedido" ? documentKindLabel[d.kind] : `${documentKindLabel[d.kind]} · ${formatShortDate(d.date)}`);
  const notesValue = savedNotes ?? order.notes ?? "";

  const movements = [
    ...order.deliveries.map((d) => ({
      id: d.id,
      date: d.date,
      kind: "entrega" as const,
      title: `Entrega · ${d.lines.map((l) => `${formatNumber(l.quantity)} ${l.unit} ${l.materialName}`).join(" y ")}`,
      sub: d.remito ? `Remito ${d.remito}` : "Sin remito",
    })),
    ...order.payments.map((p) => ({
      id: p.id,
      date: p.date,
      kind: "pago" as const,
      title: `Pago · ${formatMoney(p.amount)}`,
      sub: `${paymentMethodLabel[p.method]} · imputado`,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="flex flex-1 flex-col lg:bg-surface">
      {/* Mobile */}
      <div className="flex flex-1 flex-col lg:hidden">
        <div className="flex items-center justify-between px-3 pt-2">
          <BackLink to="/pedidos" label="Pedidos" />
          <IconButton icon={Ellipsis} label="Más acciones" tone="plain" size={44} onClick={() => navigate({ to: "/proveedores/$supplierId", params: { supplierId: order.supplier.id } })} />
        </div>
        <div className="flex flex-col gap-1.5 px-4 pt-1 pb-4">
          <h1 className="text-[26px] font-semibold tracking-[-0.5px] text-fg">Pedido {order.number}</h1>
          <p className="text-sm text-fg-3">
            {order.supplier.name} · {formatDate(order.date)} · {order.orderedBy}
          </p>
        </div>
        <div className="flex flex-col gap-6 px-4 pb-28">
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <div className="flex flex-col gap-2.5 p-3.5">
              <div className="flex items-center gap-2">
                <Truck size={16} className={order.delivery.status === "pendiente" ? "text-fg-2" : order.delivery.status === "entregado" ? "text-success" : "text-info"} />
                <span className="flex-1 text-sm font-medium text-fg-2">{deliveryTitle(order)}</span>
                <span className="font-mono text-base font-semibold text-fg">
                  {formatNumber(order.delivery.delivered)} de {formatNumber(order.delivery.ordered)} u
                </span>
              </div>
              <Progress value={deliveredPct} tone={deliveryTone(order)} />
              <span className="text-xs text-fg-3">
                {order.delivery.pendingLabel ?? "Todo entregado"} · {order.deliveries.length} {order.deliveries.length === 1 ? "entrega" : "entregas"}
              </span>
            </div>
            <div className="flex flex-col gap-2.5 border-t border-border p-3.5">
              <div className="flex items-center gap-2">
                <Wallet size={16} className={order.payment.status === "parcial" ? "text-warning" : order.payment.status === "pagado" ? "text-success" : "text-fg-2"} />
                <span className="flex-1 text-sm font-medium text-fg-2">{paymentTitle(order)}</span>
                <span className="font-mono text-base font-semibold text-fg">{formatMoney(order.payment.paid)}</span>
              </div>
              <Progress value={order.payment.percent ?? 0} tone={order.payment.status === "pagado" ? "success" : "warning"} />
              <span className="text-xs text-fg-3">
                {order.total === null ? "Importe a confirmar" : `Pendiente ${formatMoney(order.pendingPayment ?? 0)} de ${formatMoney(order.total)}`}
              </span>
            </div>
          </div>

          <section className="flex flex-col gap-2.5">
            <h2 className="text-base font-semibold text-fg">Materiales</h2>
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              {order.lines.map((l, i) => {
                const pct = (l.delivered / l.quantity) * 100;
                const done = l.delivered >= l.quantity;
                return (
                  <div key={l.id} className={cn("flex flex-col gap-2.5 p-3.5", i > 0 && "border-t border-border")}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[15px] font-medium text-fg">{l.materialName}</span>
                      <span className="font-mono text-[13px] text-fg-2">{l.amount === null ? "sin precio" : formatMoney(l.amount)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Progress value={pct} tone={done ? "success" : "info"} className="flex-1" />
                      <span className={cn("font-mono text-sm font-medium", done ? "text-success" : "text-info")}>
                        {formatNumber(l.delivered)} / {formatNumber(l.quantity)} u
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-fg">Movimientos</h2>
            {movements.length === 0 ? (
              <p className="text-sm text-fg-3">Todavía no hay entregas ni pagos.</p>
            ) : (
              <div className="flex flex-col">
                {movements.map((m, i) => (
                  <div key={m.id} className="flex gap-3">
                    <span className="flex flex-col items-center gap-1">
                      <span className={cn("flex size-7 items-center justify-center rounded-full", m.kind === "entrega" ? "bg-info-soft text-info" : "bg-success-soft text-success")}>
                        {m.kind === "entrega" ? <Truck size={14} /> : <Wallet size={14} />}
                      </span>
                      {i < movements.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                    </span>
                    <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5 pt-1", i < movements.length - 1 && "pb-5")}>
                      <span className="flex gap-2">
                        <span className="flex-1 text-[15px] font-medium text-fg">{m.title}</span>
                        <span className="font-mono text-xs text-fg-3">{formatShortDate(m.date)}</span>
                      </span>
                      <span className="text-[13px] text-fg-3">{m.sub}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2.5">
            <h2 className="text-base font-semibold text-fg">Documentos · {order.documents.length}</h2>
            {order.documents.length === 0 ? (
              <p className="text-sm text-warning">Sin comprobante de pedido. Envíalo al asistente para adjuntarlo.</p>
            ) : (
              order.documents.map((d) => <DocChip key={d.id} fileName={d.fileName} meta={docMeta(d)} format={d.format} wide onClick={() => setPreview(d)} />)
            )}
          </section>
        </div>
        <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2.5 border-t border-border bg-surface px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
          <Button variant="secondary" icon={Wallet} size="lg" className="flex-1" onClick={() => setPaymentOpen(true)} disabled={order.payment.status === "pagado"}>
            Registrar pago
          </Button>
          <Button icon={Truck} size="lg" className="flex-1" onClick={() => setDeliveryOpen(true)} disabled={order.delivery.status === "entregado"}>
            Registrar entrega
          </Button>
        </div>
      </div>

      {/* Desktop */}
      <div className="hidden flex-col gap-6 px-8 py-6 lg:flex">
        <Breadcrumb items={[{ label: "Pedidos", to: "/pedidos" }, { label: order.number }]} />
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[28px] font-semibold tracking-[-0.6px] text-fg">Pedido {order.number}</h1>
              <Pill tag={deliveryTag[order.delivery.status]} />
              <Pill tag={paymentTag[order.payment.status]} />
              {!order.hasDocument ? <Pill tag="sin_comprobante" /> : null}
            </div>
            <p className="text-sm text-fg-3">
              {order.supplier.name} · {formatDate(order.date)} · pedido por {order.orderedBy} · {purchaseModeLabel[order.mode].toLowerCase()}
            </p>
          </div>
          <div className="relative">
            <IconButton icon={Ellipsis} label="Más acciones" size={44} onClick={() => setMenuOpen((v) => !v)} />
            {menuOpen ? (
              <div className="absolute top-12 right-0 z-20 flex w-56 animate-pop-in flex-col rounded-[10px] border border-border bg-surface p-1 shadow-sheet" onMouseLeave={() => setMenuOpen(false)}>
                <Link to="/proveedores/$supplierId" params={{ supplierId: order.supplier.id }} className="rounded-md px-3 py-2 text-sm text-fg hover:bg-sunken">
                  Ver cuenta corriente
                </Link>
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-left text-sm text-fg hover:bg-sunken"
                  onClick={() => {
                    void navigator.clipboard?.writeText(window.location.href);
                    setMenuOpen(false);
                    toast("Enlace copiado");
                  }}
                >
                  Copiar enlace
                </button>
                <button type="button" className="rounded-md px-3 py-2 text-left text-sm text-fg hover:bg-sunken" onClick={askToEdit}>
                  Corregir con el asistente
                </button>
              </div>
            ) : null}
          </div>
          <Button variant="secondary" icon={Wallet} onClick={() => setPaymentOpen(true)} disabled={order.payment.status === "pagado"}>
            Registrar pago
          </Button>
          <Button icon={Truck} onClick={() => setDeliveryOpen(true)} disabled={order.delivery.status === "entregado"}>
            Registrar entrega
          </Button>
        </div>

        <div className="flex gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-7">
            <div className="flex gap-4">
              <Dimension
                icon={<Truck size={16} className={order.delivery.status === "pendiente" ? "text-fg-2" : "text-info"} />}
                title="Entrega"
                big={`${formatNumber(order.delivery.delivered)} de ${formatNumber(order.delivery.ordered)} u`}
                sub={`${Math.round(deliveredPct)}% entregado`}
                pct={deliveredPct}
                tone={deliveryTone(order)}
                kv={[
                  { k: "Entregas", v: String(order.deliveries.length) },
                  { k: "Última", v: lastDelivery ? formatDate(lastDelivery.date) : "—" },
                  { k: "Pendiente", v: pendingShort(order), className: order.delivery.status !== "entregado" ? "text-info" : undefined },
                ]}
              />
              <Dimension
                icon={<Wallet size={16} className={order.payment.status === "parcial" ? "text-warning" : order.payment.status === "pagado" ? "text-success" : "text-fg-2"} />}
                title="Pago"
                big={formatMoney(order.payment.paid)}
                sub={order.total === null ? "importe a confirmar" : `de ${formatMoney(order.total)} · ${order.payment.percent ?? 0}%`}
                pct={order.payment.percent ?? 0}
                tone={order.payment.status === "pagado" ? "success" : "warning"}
                kv={[
                  { k: "Pagos", v: String(order.payments.length) },
                  { k: "Último", v: lastPayment ? formatDate(lastPayment.date) : "—" },
                  { k: "Pendiente", v: order.pendingPayment === null ? "A confirmar" : formatMoney(order.pendingPayment), className: (order.pendingPayment ?? 0) > 0 ? "text-warning" : undefined },
                ]}
              />
            </div>

            <section className="flex flex-col gap-3">
              <SectionHead title="Materiales" action={<LinkButton onClick={askToEdit}>Editar</LinkButton>} />
              <div className="overflow-hidden rounded-[10px] border border-border">
                <div className="flex gap-4 bg-sunken px-4 py-2.5 text-xs font-medium text-fg-3">
                  <span className="flex-1">Material</span>
                  <span className="w-20 text-right">Pedido</span>
                  <span className="w-40">Entregado</span>
                  <span className="w-[84px] text-right">Pendiente</span>
                  <span className="w-[100px] text-right">P. unitario</span>
                  <span className="w-[110px] text-right">Importe</span>
                </div>
                {order.lines.map((l) => {
                  const pending = l.quantity - l.delivered;
                  const done = pending <= 0;
                  return (
                    <div key={l.id} className="flex h-[60px] items-center gap-4 border-t border-border px-4">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium text-fg">{l.materialName}</span>
                        {l.spec ? <span className="text-xs text-fg-3">{l.spec}</span> : null}
                      </span>
                      <span className="w-20 text-right font-mono text-sm text-fg">{formatNumber(l.quantity)} u</span>
                      <span className="flex w-40 items-center gap-2.5">
                        <Progress value={(l.delivered / l.quantity) * 100} tone={done ? "success" : "info"} className="w-20" />
                        <span className={cn("font-mono text-sm font-medium", l.delivered === 0 ? "text-fg-3" : done ? "text-success" : "text-info")}>{formatNumber(l.delivered)} u</span>
                      </span>
                      <span className={cn("w-[84px] text-right font-mono text-sm", done ? "text-fg-3" : "font-semibold text-fg")}>{formatNumber(pending)} u</span>
                      <span className="w-[100px] text-right font-mono text-sm text-fg-2">{l.unitPrice === null ? "—" : formatMoney(l.unitPrice)}</span>
                      <span className="w-[110px] text-right font-mono text-sm text-fg">{l.amount === null ? "—" : formatMoney(l.amount)}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-4 border-t border-border bg-sunken px-4 py-3">
                  <span className="flex-1 text-[13px] text-fg-2">Total del pedido</span>
                  <span className="font-mono text-[15px] font-semibold text-fg">{order.total === null ? "A confirmar" : formatMoney(order.total)}</span>
                </div>
              </div>
            </section>

            <div className="flex gap-6">
              <section className="flex min-w-0 flex-1 flex-col gap-3">
                <SectionHead title={`Entregas · ${order.deliveries.length}`} action={order.delivery.status !== "entregado" ? <LinkButton onClick={() => setDeliveryOpen(true)}>+ Registrar</LinkButton> : null} />
                {order.deliveries.map((d) => (
                  <Movement
                    key={d.id}
                    tile="bg-info-soft text-info"
                    icon={<Truck size={16} />}
                    title={d.remito ? `Remito ${d.remito}` : "Entrega sin remito"}
                    date={formatDate(d.date)}
                    sub={d.lines.map((l) => `${formatNumber(l.quantity)} ${l.unit} ${l.materialName}`).join(" · ")}
                    doc={d.document}
                    onDoc={setPreview}
                  />
                ))}
                {order.delivery.status !== "entregado" ? (
                  <div className="flex items-center gap-2.5 rounded-lg bg-info-soft px-3 py-2.5 text-[13px] font-medium text-info">
                    <Hourglass size={16} />
                    {order.delivery.status === "pendiente" ? "Todavía no llegó nada de este pedido" : order.delivery.pendingLabel}
                  </div>
                ) : null}
              </section>
              <section className="flex min-w-0 flex-1 flex-col gap-3">
                <SectionHead title={`Pagos · ${order.payments.length}`} action={order.payment.status !== "pagado" ? <LinkButton onClick={() => setPaymentOpen(true)}>+ Registrar</LinkButton> : null} />
                {order.payments.map((p) => (
                  <Movement
                    key={p.id}
                    tile="bg-success-soft text-success"
                    icon={<Wallet size={16} />}
                    title={paymentMethodLabel[p.method]}
                    date={formatDate(p.date)}
                    sub={`${formatMoney(p.amount)} imputado a este pedido`}
                    doc={p.document}
                    onDoc={setPreview}
                  />
                ))}
                {(order.pendingPayment ?? 0) > 0 ? (
                  <div className="flex items-center gap-2.5 rounded-lg bg-warning-soft px-3 py-2.5 text-[13px] font-medium text-warning">
                    <Wallet size={16} />
                    Pendiente de pago: {formatMoney(order.pendingPayment ?? 0)}
                  </div>
                ) : order.total === null ? (
                  <div className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] font-medium text-fg-2">
                    <Wallet size={16} />
                    Importe a confirmar: el pendiente se calcula cuando se conozca el total
                  </div>
                ) : null}
                {order.supplierUnallocated > 0 && (order.pendingPayment ?? 0) > 0 ? (
                  <div className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
                    <Coins size={16} className="text-ai" />
                    <span className="flex-1 text-[13px] text-fg-2">
                      {order.supplier.name} tiene {formatMoney(order.supplierUnallocated)} sin imputar
                    </span>
                    <button type="button" onClick={allocateHere} className="text-[13px] font-semibold text-accent">
                      Imputar aquí
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          </div>

          <aside className="flex w-[320px] shrink-0 flex-col gap-6">
            <section className="flex flex-col gap-2.5">
              <SectionHead title="Datos" small action={<LinkButton onClick={askToEdit}>Editar</LinkButton>} />
              <KV k="Proveedor">
                <Link to="/proveedores/$supplierId" params={{ supplierId: order.supplier.id }} className="font-medium text-accent hover:underline">
                  {order.supplier.name}
                </Link>
              </KV>
              <KV k="N.º externo" mono>
                {order.number}
              </KV>
              <KV k="Fecha" mono>
                {formatDate(order.date)}
              </KV>
              <KV k="Pedido por">
                {order.orderedBy}
                {order.orderedByRole ? ` (${order.orderedByRole})` : ""}
              </KV>
              <KV k="Modalidad">{purchaseModeLabel[order.mode]}</KV>
              <KV k="Registrado">
                {formatDate(order.registeredAt)} · {order.registeredVia === "asistente" ? "desde el asistente" : "carga manual"}
              </KV>
            </section>
            <section className="flex flex-col gap-2.5">
              <SectionHead
                title={`Documentos · ${order.documents.length}`}
                small
                action={
                  <LinkButton
                    onClick={() => {
                      navigate({ to: "/" });
                      toast("Adjunta el comprobante en el asistente", "info");
                    }}
                  >
                    + Adjuntar
                  </LinkButton>
                }
              />
              {order.documents.length === 0 ? (
                <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-border-strong px-3.5 py-3 text-[13px] text-fg-3">
                  <Paperclip size={16} />
                  Sin comprobante de pedido
                </div>
              ) : (
                order.documents.map((d) => <DocChip key={d.id} fileName={d.fileName} meta={docMeta(d)} format={d.format} wide onClick={() => setPreview(d)} />)
              )}
            </section>
            <section className="flex flex-col gap-3">
              <SectionHead title="Historial" small />
              <div className="flex flex-col">
                {order.history.map((e, i) => (
                  <ActivityItem
                    key={e.id}
                    event={{ ...e, description: e.changes?.length && e.kind === "registro_corregido" ? e.changes.map((c) => `${c.label}: ${c.before} → ${c.after}`).join(" · ") : e.shortDescription ?? e.description }}
                    time={formatShortDate(e.at)}
                    last={i === order.history.length - 1}
                    detailed={false}
                  />
                ))}
              </div>
            </section>
            <section className="flex flex-col gap-2.5">
              <SectionHead title="Notas" small action={notes === null ? <LinkButton onClick={() => setNotes(notesValue)}>Editar</LinkButton> : null} />
              {notes !== null ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    autoFocus
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    className="w-full rounded-[10px] border border-accent bg-surface px-3 py-2.5 text-[13px] leading-[19px] text-fg outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setNotes(null)}>
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setSavedNotes(notes);
                        setNotes(null);
                        toast("Nota guardada");
                      }}
                    >
                      Guardar
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="rounded-[10px] bg-surface-2 px-3 py-2.5 text-[13px] leading-[19px] text-fg-2">{notesValue || "Sin notas."}</p>
              )}
            </section>
          </aside>
        </div>
      </div>

      <DocumentPreview doc={preview} onClose={() => setPreview(null)} />
      <RegisterDeliverySheet order={order} open={deliveryOpen} onClose={() => setDeliveryOpen(false)} today={today} />
      <RegisterPaymentSheet
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        today={today}
        supplier={order.supplier}
        balance={supplierBalance}
        defaultOrderId={order.id}
        orders={supplierOrders.map((o) => ({ id: o.id, number: o.number, pendingPayment: o.pendingPayment, deliveryStatus: o.delivery.status }))}
      />
    </div>
  );
}

function SectionHead({ title, action, small }: { title: string; action?: React.ReactNode; small?: boolean }) {
  return (
    <div className="flex items-center">
      <h2 className={cn("flex-1 font-semibold text-fg", small ? "text-sm" : "text-base")}>{title}</h2>
      {action}
    </div>
  );
}

function Dimension({
  icon,
  title,
  big,
  sub,
  pct,
  tone,
  kv,
}: {
  icon: React.ReactNode;
  title: string;
  big: string;
  sub: string;
  pct: number;
  tone: "info" | "success" | "warning";
  kv: { k: string; v: string; className?: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-[10px] border border-border p-[18px]">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-fg-2">
        {icon}
        {title}
      </span>
      <span className="flex items-end gap-2">
        <span className="font-mono text-2xl font-semibold tracking-[-0.5px] text-fg">{big}</span>
        <span className="pb-0.5 text-[13px] text-fg-3">{sub}</span>
      </span>
      <Progress value={pct} tone={tone} height={8} />
      <div className="flex gap-4">
        {kv.map((x) => (
          <span key={x.k} className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs text-fg-3">{x.k}</span>
            <span className={cn("truncate font-mono text-sm font-medium text-fg", x.className)}>{x.v}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Movement({ tile, icon, title, date, sub, doc, onDoc }: { tile: string; icon: React.ReactNode; title: string; date: string; sub: string; doc?: DocumentRef; onDoc: (d: DocumentRef) => void }) {
  return (
    <div className="flex gap-3 border-b border-border pt-1 pb-4">
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", tile)}>{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex gap-2">
          <span className="flex-1 text-sm font-medium text-fg">{title}</span>
          <span className="font-mono text-xs text-fg-3">{date}</span>
        </span>
        <span className="text-[13px] text-fg-2">{sub}</span>
        {doc ? (
          <button type="button" onClick={() => onDoc(doc)} className="flex items-center gap-1.5 pt-0.5 text-xs font-medium text-accent hover:underline">
            <Paperclip size={12} />
            {doc.fileName}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function KV({ k, children, mono }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 text-[13px]">
      <span className="w-[100px] shrink-0 text-fg-3">{k}</span>
      <span className={cn("min-w-0 flex-1 font-medium text-fg", mono && "font-mono")}>{children}</span>
    </div>
  );
}

function OrderDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 px-4 py-6 lg:bg-surface lg:px-8">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-56" />
      <div className="flex flex-col gap-4 lg:flex-row">
        <Skeleton className="h-40 flex-1" />
        <Skeleton className="h-40 flex-1" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

