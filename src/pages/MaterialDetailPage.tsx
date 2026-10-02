import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowRight, Boxes, Check, Flag, Gauge, PackageCheck, Pencil, Target, TriangleAlert, Truck } from "lucide-react";
import type { MaterialDetail } from "@/domain/types";
import { formatDate, formatNumber } from "@/domain/format";
import { Breadcrumb, MobileHeader } from "@/components/layout/MobileHeader";
import { Footnote } from "@/components/layout/Page";
import { Button } from "@/components/ui/Button";
import { FieldLabel, TextInput } from "@/components/ui/Fields";
import { Pill, deliveryTag, paymentTag } from "@/components/ui/Pill";
import { ComputationBar, Progress } from "@/components/ui/Progress";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useAdjustComputation, useMarkReviewed, useMaterial } from "@/queries";
import { parseQuantityInput } from "@/features/assistant/cards/parts";
import { errorMessage } from "@/services/api/client";

function statusTag(m: MaterialDetail) {
  const s = m.computation?.status;
  return s === "supera" ? "computo_supera" : s === "cerca" ? "computo_cerca" : s === "alcanzado" ? "computo_alcanzado" : null;
}

function unitShort(m: MaterialDetail) {
  return m.unit;
}

export function MaterialDetailPage() {
  const { materialId } = useParams({ from: "/materiales/$materialId" });
  const toast = useToast();
  const { data: m, isPending, isError, error, refetch, isRefetching } = useMaterial(materialId);
  const markReviewed = useMarkReviewed();
  const [adjustOpen, setAdjustOpen] = useState(false);

  if (isPending) {
    return (
      <div className="flex flex-col gap-5 px-5 py-6 lg:px-10 lg:py-8">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-52 w-full rounded-[14px]" />
        <Skeleton className="h-48 w-full rounded-[14px]" />
      </div>
    );
  }
  if (isError || !m) {
    return error?.name === "NotFoundError" ? (
      <EmptyState icon={Boxes} title="No encontramos este material" actions={<Link to="/materiales" className="text-sm font-medium text-accent">Ver materiales</Link>} className="flex-1" />
    ) : (
      <ErrorState title="No pudimos cargar el material" onRetry={() => refetch()} retrying={isRefetching} className="flex-1" />
    );
  }

  const c = m.computation;
  const tag = statusTag(m);
  const unit = unitShort(m);
  // Secondary: derived equivalent (172 barras = 2.064 m) and quantities in units that can't be converted (never added).
  const unitsNote = [m.equivalent ? `Equivale a ${formatNumber(m.equivalent.quantity)} ${m.equivalent.unit}` : "", m.otherUnits ? `Además se pidieron ${m.otherUnits}, sin conversión a ${m.unit}` : ""].filter(Boolean).join(" · ");
  const lastChange = m.computationChanges.at(-1);
  const review = () => markReviewed.mutate(m.id, { onSuccess: () => toast("Marcado como revisado") });
  const subtitle = `${m.unit.charAt(0).toUpperCase()}${m.unit.slice(1)} · ${m.category} · Proveedor habitual: ${m.usualSupplier}`;

  const banner = (() => {
    if (!c) return { tone: "info", icon: Boxes, text: "Este material todavía no está en el cómputo. Se muestran las cantidades pedidas y entregadas; puedes definir una cantidad prevista para compararlo." };
    if (c.status === "supera")
      return {
        tone: "danger",
        icon: Flag,
        text: `Revisar: el total pedido supera el cómputo en ${formatNumber(c.variation)} ${unit}. Puede ser material de reposición o un cómputo desactualizado${lastChange ? ` (última actualización: ${formatDate(lastChange.date)}, ${lastChange.before === null ? `definido en ${formatNumber(lastChange.after)}` : `de ${formatNumber(lastChange.before)} a ${formatNumber(lastChange.after)}`} ${unit})` : ""}.`,
        mobile: `El total pedido supera el cómputo en ${formatNumber(c.variation)} ${unit}. Puede ser reposición o un cómputo desactualizado.`,
      };
    if (c.status === "cerca") return { tone: "warning", icon: Gauge, text: `Cerca del cómputo: ya se pidió el ${c.percent}%. Quedan ${formatNumber(c.remaining)} ${unit} según lo previsto.` };
    if (c.status === "alcanzado") return { tone: "accent", icon: Target, text: "Cómputo alcanzado: lo pedido coincide con lo previsto. Un pedido más lo superaría." };
    return null;
  })();
  const bannerTone = {
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-warning",
    accent: "bg-accent-soft text-accent",
    info: "bg-sunken text-fg-2",
  } as const;

  const barToneFor = c?.status === "supera" ? "warning" : c?.status === "cerca" ? "warning" : c?.status === "alcanzado" ? "accent" : "neutral";

  return (
    <div className="flex flex-1 flex-col pb-8 lg:gap-5 lg:px-10 lg:pt-8 lg:pb-10">
      <MobileHeader back={{ to: "/materiales", label: "Materiales" }} title={m.name} />

      <div className="hidden flex-col gap-5 lg:flex">
        <Breadcrumb items={[{ label: "Materiales y cómputo", to: "/materiales" }, { label: m.name }]} />
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-[28px] font-semibold tracking-[-0.6px] text-fg">{m.name}</h1>
            <p className="text-sm text-fg-2">{subtitle}</p>
          </div>
          <Button variant="secondary" icon={Pencil} onClick={() => setAdjustOpen(true)}>
            {c ? "Ajustar cómputo" : "Definir cómputo"}
          </Button>
          {c && c.status !== "dentro" ? (
            <Button icon={Check} onClick={review} loading={markReviewed.isPending} disabled={m.reviewed}>
              {m.reviewed ? "Revisado" : "Marcar como revisado"}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Summary */}
      <div className="hidden flex-col gap-4 rounded-[14px] border border-border bg-surface p-6 lg:flex">
        <div className="flex [&>*+*]:border-l [&>*+*]:border-border">
          <Figure label="Cómputo" value={c ? formatNumber(c.expected) : "—"} unit={c ? unit : undefined} first />
          <Figure label="Pedido acumulado" value={formatNumber(m.ordered)} unit={unit} />
          <Figure label="Entregado acumulado" value={formatNumber(m.delivered)} unit={unit} />
          <Figure
            label="Variación"
            value={c ? (c.variation > 0 ? `+${formatNumber(c.variation)}` : c.remaining > 0 ? `−${formatNumber(c.remaining)}` : "0") : "—"}
            unit={c ? `${unit}${c.variation > 0 ? ` · +${c.percent - 100}%` : ""}` : undefined}
            valueClassName={c && c.variation > 0 ? "text-danger" : undefined}
          />
        </div>
        {unitsNote ? <p className="-mt-1 font-mono text-xs text-fg-3">{unitsNote}</p> : null}
        {c ? (
          <div className="flex flex-col gap-2">
            <ComputationBar percent={c.percent} tone={barToneFor} height={8} split />
            <div className="flex justify-between font-mono text-xs">
              <span className="text-fg-3">0</span>
              <span className="text-fg-2">
                Cómputo {formatNumber(c.expected)} · <span className={c.status === "supera" ? "text-danger" : ""}>pedido {formatNumber(m.ordered)} ({c.percent}%)</span>
              </span>
            </div>
          </div>
        ) : null}
        {banner ? (
          <div className={cn("flex items-center gap-3 rounded-[10px] px-4 py-3", bannerTone[banner.tone as keyof typeof bannerTone])}>
            <banner.icon size={16} className="shrink-0" />
            <p className="flex-1 text-[13px] leading-[19px] text-fg">{banner.text}</p>
            {tag ? <Pill tag={tag} className="bg-transparent" /> : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4 px-5 pb-6 lg:hidden">
        {tag ? <Pill tag={tag} className="self-start" /> : null}
        <div className="flex [&>*+*]:border-l [&>*+*]:border-border">
          <Figure label="Cómputo" value={c ? formatNumber(c.expected) : "—"} unit={c ? unit : undefined} first small />
          <Figure label="Pedido" value={formatNumber(m.ordered)} unit={unit} small />
          <Figure label="Entregado" value={formatNumber(m.delivered)} unit={unit} small />
        </div>
        {unitsNote ? <p className="-mt-1 font-mono text-xs text-fg-3">{unitsNote}</p> : null}
        {c ? (
          <>
            <ComputationBar percent={c.percent} tone={barToneFor} height={8} split />
            <div className="flex justify-between font-mono text-xs">
              <span className={c.status === "supera" ? "text-danger" : "text-fg-2"}>{c.percent}% del cómputo pedido</span>
              <span className="text-fg-2">Variación {c.variation > 0 ? `+${formatNumber(c.variation)}` : "0"}</span>
            </div>
          </>
        ) : null}
        {banner ? (
          <div className={cn("flex flex-col gap-3 rounded-xl p-4", bannerTone[banner.tone as keyof typeof bannerTone])}>
            <span className="flex items-center gap-2 text-[15px] font-semibold text-fg">
              <banner.icon size={16} className="text-current" />
              {c?.status === "supera" ? "Para revisar" : c ? "Estado del cómputo" : "Sin cómputo"}
            </span>
            <p className="text-[13px] leading-[19px] text-fg-2">{"mobile" in banner && banner.mobile ? banner.mobile : banner.text}</p>
            <div className="flex gap-2">
              <Button variant="secondary" size="lg" className="flex-1" onClick={() => setAdjustOpen(true)}>
                {c ? "Ajustar cómputo" : "Definir cómputo"}
              </Button>
              {c && c.status !== "dentro" ? (
                <Button icon={Check} size="lg" className="flex-1" onClick={review} loading={markReviewed.isPending} disabled={m.reviewed}>
                  Revisado
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <section className="flex min-w-0 flex-1 flex-col gap-3 px-5 lg:px-0">
          <h2 className="text-base font-semibold tracking-[-0.2px] text-fg">Pedidos que componen el total</h2>
          <div className="hidden overflow-hidden rounded-[14px] border border-border bg-surface lg:block">
            <div className="flex h-10 items-center gap-3 bg-sunken px-5 text-xs font-medium text-fg-3">
              <span className="w-[96px]">Pedido</span>
              <span className="w-[96px]">Fecha</span>
              <span className="flex-1">Estados</span>
              <span className="w-[64px] text-right">Pedido</span>
              <span className="w-[84px] text-right">Entregado</span>
              <span className="w-[84px] text-right">Acumulado</span>
            </div>
            {m.orders.map((o) => (
              <Link key={o.orderId} to="/pedidos/$orderId" params={{ orderId: o.orderId }} className="flex h-[52px] items-center gap-3 border-t border-border px-5 hover:bg-sunken">
                <span className="w-[96px] font-mono text-[13px] font-semibold text-fg">Pedido {o.orderNumber}</span>
                <span className="w-[96px] font-mono text-xs text-fg-2">{formatDate(o.date)}</span>
                <span className="flex flex-1 gap-1.5">
                  <Pill tag={deliveryTag[o.delivery]} />
                  <Pill tag={paymentTag[o.payment]} />
                </span>
                <span className="w-[64px] text-right font-mono text-[13px] text-fg">
                  {formatNumber(o.ordered)}
                  {o.unit ? ` ${o.unit}` : ""}
                </span>
                <span className={cn("w-[84px] text-right font-mono text-[13px]", o.delivered < o.ordered ? "text-info" : "text-fg-2")}>{formatNumber(o.delivered)}</span>
                <span className={cn("w-[84px] text-right font-mono text-[13px] font-semibold", c && o.cumulative > c.expected ? "text-danger" : "text-fg")}>{formatNumber(o.cumulative)}</span>
              </Link>
            ))}
            <div className="flex h-11 items-center gap-3 border-t border-border bg-sunken px-5">
              <span className="flex-1 text-[13px] font-semibold text-fg">
                Total · {m.orders.length} {m.orders.length === 1 ? "pedido" : "pedidos"} de {m.usualSupplier}
              </span>
              <span className="w-[64px] text-right font-mono text-[13px] font-semibold text-fg">{formatNumber(m.ordered)}</span>
              <span className="w-[84px] text-right font-mono text-[13px] text-info">{formatNumber(m.delivered)}</span>
              <span className="w-[84px]" />
            </div>
          </div>
          <div className="overflow-hidden rounded-[14px] border border-border bg-surface lg:hidden">
            {m.orders.map((o, i) => (
              <Link key={o.orderId} to="/pedidos/$orderId" params={{ orderId: o.orderId }} className={cn("flex flex-col gap-2.5 p-4", i > 0 && "border-t border-border")}>
                <span className="flex items-baseline justify-between">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[15px] font-semibold text-fg">Pedido {o.orderNumber}</span>
                    <span className="font-mono text-xs text-fg-3">{formatDate(o.date)}</span>
                  </span>
                  <span className="font-mono text-sm font-semibold text-fg">
                    {formatNumber(o.ordered)} {o.unit ?? unit}
                  </span>
                </span>
                <span className="flex gap-1.5">
                  <Pill tag={deliveryTag[o.delivery]} />
                  <Pill tag={paymentTag[o.payment]} />
                </span>
                <span className={cn("font-mono text-xs", o.delivered < o.ordered ? "text-info" : "text-fg-3")}>
                  Entregado {formatNumber(o.delivered)} de {formatNumber(o.ordered)} · acumulado {formatNumber(o.cumulative)}
                </span>
              </Link>
            ))}
            <div className="flex items-center justify-between border-t border-border bg-sunken px-4 py-3">
              <span className="text-[13px] font-semibold text-fg">Total pedido</span>
              <span className="font-mono text-[13px] text-fg">
                {formatNumber(m.ordered)} {unit} · entregado {formatNumber(m.delivered)}
              </span>
            </div>
          </div>
          <Footnote className="hidden lg:flex">El estado de entrega y el de pago se muestran por separado para cada pedido.</Footnote>
        </section>

        <aside className="flex w-full flex-col gap-6 px-5 lg:w-[300px] lg:shrink-0 lg:gap-4 lg:px-0">
          <section className="hidden flex-col gap-3 lg:flex">
            <h2 className="text-base font-semibold tracking-[-0.2px] text-fg">Entregas</h2>
            <div className="overflow-hidden rounded-[14px] border border-border bg-surface">
              {m.deliveries.length === 0 ? <p className="px-4 py-4 text-[13px] text-fg-3">Todavía no hubo entregas.</p> : null}
              {m.deliveries.map((d, i) => (
                <div key={d.id} className={cn("flex items-center gap-3 px-4 py-3", i > 0 && "border-t border-border")}>
                  {d.pending ? <Truck size={16} className="text-info" /> : <PackageCheck size={16} className="text-success" />}
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">{d.label}</span>
                    <span className="font-mono text-xs text-fg-3">{d.date ? formatDate(d.date) : "Pendiente"}</span>
                  </span>
                  <span className={cn("font-mono text-[13px]", d.pending ? "text-info" : "text-fg")}>
                    {formatNumber(d.quantity)} {unit}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-3 lg:pt-2">
            <h2 className="text-base font-semibold tracking-[-0.2px] text-fg">Cambios en el cómputo</h2>
            {m.computationChanges.length === 0 ? (
              <p className="text-[13px] text-fg-3">Sin cambios desde que se cargó.</p>
            ) : (
              m.computationChanges.map((ch, i) => (
                <div key={i} className="flex flex-col gap-2.5 lg:rounded-[14px] lg:border lg:border-border lg:bg-surface lg:p-4">
                  <span className="hidden items-center justify-between lg:flex">
                    <span className="text-sm font-medium text-fg">Cómputo actualizado</span>
                    <span className="font-mono text-xs text-fg-3">{formatDate(ch.date)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-fg-3 lg:hidden">{formatDate(ch.date)}</span>
                    <span className="rounded-[5px] bg-surface-2 px-[7px] py-0.5 font-mono text-xs text-fg-3">
                      {ch.before === null ? "Sin cómputo" : formatNumber(ch.before)}
                      {ch.before === null ? null : <span className="hidden lg:inline"> {unit}</span>}
                    </span>
                    <ArrowRight size={12} className="text-fg-3" />
                    <span className="rounded-[5px] bg-accent-soft px-[7px] py-0.5 font-mono text-xs font-semibold text-accent">
                      {formatNumber(ch.after)} {unit}
                    </span>
                    <span className="text-xs text-fg-3 lg:hidden">{ch.by.replace(/^(\w)\w+ /, "$1. ")}</span>
                  </span>
                  <span className="hidden text-xs text-fg-3 lg:block">
                    Por {ch.by}
                    {ch.byRole ? ` · ${ch.byRole}` : ""}
                  </span>
                </div>
              ))
            )}
          </section>
        </aside>
      </div>

      <AdjustSheet material={m} open={adjustOpen} onClose={() => setAdjustOpen(false)} />
    </div>
  );
}

function Figure({ label, value, unit, valueClassName, first, small }: { label: string; value: string; unit?: string; valueClassName?: string; first?: boolean; small?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-1", first ? "pr-4" : "px-4 lg:px-6")}>
      <span className={cn("text-fg-3", small ? "text-xs" : "text-[13px]")}>{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className={cn("font-mono font-semibold text-fg", small ? "text-[22px]" : "text-[26px]", valueClassName)}>{value}</span>
        {unit ? <span className="truncate text-xs text-fg-3">{unit}</span> : null}
      </span>
    </div>
  );
}

function AdjustSheet({ material, open, onClose }: { material: MaterialDetail; open: boolean; onClose: () => void }) {
  const adjust = useAdjustComputation();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) {
      setValue(formatNumber(material.computation?.expected ?? material.ordered));
      setReason("");
    }
  }, [open, material]);
  const n = parseQuantityInput(value) ?? 0;
  const pct = n ? Math.round((material.ordered / n) * 100) : 0;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={material.computation ? "Ajustar cómputo" : "Definir cómputo"}
      subtitle={material.name}
      footer={
        <Button
          icon={Check}
          size="lg"
          className="flex-1"
          disabled={n <= 0}
          loading={adjust.isPending}
          onClick={() =>
            adjust.mutate(
              { id: material.id, expected: n, reason: reason.trim() || undefined },
              {
                onSuccess: () => {
                  onClose();
                  toast("Cómputo actualizado");
                },
                onError: (error) => toast(errorMessage(error, "No se pudo guardar el cómputo."), "info"),
              },
            )
          }
        >
          Guardar
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pb-4">
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Cantidad prevista ({material.unit})</FieldLabel>
          <TextInput mono inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="text-lg font-semibold" />
        </label>
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Motivo (opcional)</FieldLabel>
          <TextInput placeholder="Ej.: se sumaron las vigas del quincho" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="flex flex-col gap-2 rounded-[10px] bg-sunken p-3">
          <span className="flex justify-between text-[13px] text-fg-2">
            <span>Pedido acumulado</span>
            <span className="font-mono text-fg">
              {formatNumber(material.ordered)} {material.unit}
            </span>
          </span>
          <Progress value={pct} tone={pct > 100 ? "danger" : pct >= 85 ? "warning" : "neutral"} />
          <span className="flex items-center gap-1.5 text-xs text-fg-3">
            {pct > 100 ? <TriangleAlert size={12} className="text-danger" /> : null}
            Quedaría en {pct}% del cómputo
          </span>
        </div>
        <p className="text-[13px] text-fg-3">El cambio queda registrado en la actividad con el valor anterior y el nuevo.</p>
      </div>
    </Sheet>
  );
}
