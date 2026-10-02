import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { OrderDetail, PurchaseMode } from "@/domain/types";
import { formatMoney, formatNumber, parseMoneyInput, purchaseModeLabel } from "@/domain/format";
import { parseQuantityInput } from "@/features/assistant/cards/parts";
import { useServices } from "@/services";
import { errorMessage } from "@/services/api/client";
import type { OrderCorrection } from "@/services/types";
import { useInvalidateAll } from "@/queries";
import { Button } from "../ui/Button";
import { FieldLabel, TextInput } from "../ui/Fields";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";

const selectClass = "h-12 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-base text-fg outline-none focus:border-accent";

/**
 * Corrects an order (number, date, prices, quantities). The previous values
 * stay in the activity history with the reason given.
 */
export function EditOrderSheet({ order, open, onClose }: { order: OrderDetail; open: boolean; onClose: () => void }) {
  const { orders } = useServices();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const [reference, setReference] = useState("");
  const [date, setDate] = useState("");
  const [orderedBy, setOrderedBy] = useState("");
  const [mode, setMode] = useState<PurchaseMode>("cuenta_corriente");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [statedTotal, setStatedTotal] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReference(order.reference ?? "");
    setDate(order.date);
    setOrderedBy(order.orderedBy === "Sin indicar" ? "" : order.orderedBy);
    setMode(order.mode);
    setPrices(Object.fromEntries(order.lines.map((l) => [l.id, l.unitPrice === null ? "" : formatMoney(l.unitPrice)])));
    setQuantities(Object.fromEntries(order.lines.map((l) => [l.id, formatNumber(l.quantity)])));
    setStatedTotal(order.statedTotal === null ? "" : formatMoney(order.statedTotal));
    setReason("");
  }, [open, order]);

  const correction = (): OrderCorrection => {
    const c: OrderCorrection = {};
    if ((reference.trim() || null) !== order.reference) c.reference = reference.trim() || null;
    if (date && date !== order.date) c.date = date;
    if ((orderedBy.trim() || "Sin indicar") !== order.orderedBy) c.orderedByName = orderedBy.trim() || null;
    if (mode !== order.mode) c.purchaseMode = mode;
    const total = parseMoneyInput(statedTotal);
    if (total !== order.statedTotal) c.statedTotal = total;
    const items = order.lines
      .map((l) => {
        const price = parseMoneyInput(prices[l.id] ?? "");
        const qty = parseQuantityInput(quantities[l.id] ?? "");
        const change: NonNullable<OrderCorrection["items"]>[number] = { id: l.id };
        if (price !== l.unitPrice) change.unitPrice = price;
        if (qty !== null && qty !== l.quantity) change.quantity = qty;
        return change;
      })
      .filter((x) => Object.keys(x).length > 1);
    if (items.length) c.items = items;
    if (Object.keys(c).length && reason.trim()) c.reason = reason.trim();
    return c;
  };

  const changes = correction();
  const hasChanges = Object.keys(changes).filter((k) => k !== "reason").length > 0;
  const invalidQty = order.lines.find((l) => {
    const q = parseQuantityInput(quantities[l.id] ?? "");
    return q === null || q <= 0 || q < l.delivered;
  });

  const save = async () => {
    setSaving(true);
    try {
      await orders.correct(order.id, changes);
      await invalidate();
      onClose();
      toast("Pedido corregido");
    } catch (error) {
      toast(errorMessage(error, "No se pudo corregir el pedido."), "info");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Corregir pedido"
      subtitle={`Pedido ${order.number} · ${order.supplier.name}`}
      size="lg"
      footer={
        <Button icon={Check} size="lg" className="flex-1 lg:flex-none" loading={saving} disabled={!hasChanges || Boolean(invalidQty)} onClick={save}>
          Guardar corrección
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pb-4">
        <div className="grid grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1.5">
            <FieldLabel>N.º de pedido</FieldLabel>
            <TextInput mono placeholder={`#${order.internalNumber}`} value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Fecha</FieldLabel>
            <TextInput mono type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Pedido por</FieldLabel>
            <TextInput value={orderedBy} placeholder="Sin indicar" onChange={(e) => setOrderedBy(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Modalidad</FieldLabel>
            <select value={mode} onChange={(e) => setMode(e.target.value as PurchaseMode)} className={selectClass}>
              {(Object.keys(purchaseModeLabel) as PurchaseMode[]).map((m) => (
                <option key={m} value={m}>
                  {purchaseModeLabel[m]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-border">
          <div className="flex gap-3 bg-sunken px-3 py-2 text-xs font-medium text-fg-3">
            <span className="flex-1">Material</span>
            <span className="w-24 text-right">Cantidad</span>
            <span className="w-32 text-right">P. unitario</span>
          </div>
          {order.lines.map((l) => (
            <div key={l.id} className="flex items-center gap-3 border-t border-border px-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-fg">{l.materialName}</span>
                <span className="text-xs text-fg-3">
                  {l.unit}
                  {l.delivered > 0 ? ` · entregado ${formatNumber(l.delivered)}` : ""}
                </span>
              </span>
              <input
                aria-label={`Cantidad de ${l.materialName}`}
                inputMode="decimal"
                value={quantities[l.id] ?? ""}
                onChange={(e) => setQuantities({ ...quantities, [l.id]: e.target.value })}
                className="h-10 w-24 rounded-lg border border-border-strong bg-surface px-2 text-right font-mono text-sm text-fg outline-none focus:border-accent"
              />
              <input
                aria-label={`Precio unitario de ${l.materialName}`}
                inputMode="decimal"
                placeholder="Sin precio"
                value={prices[l.id] ?? ""}
                onChange={(e) => setPrices({ ...prices, [l.id]: e.target.value })}
                onBlur={() => {
                  const v = parseMoneyInput(prices[l.id] ?? "");
                  if (v !== null) setPrices({ ...prices, [l.id]: formatMoney(v) });
                }}
                className="h-10 w-32 rounded-lg border border-border-strong bg-surface px-2 text-right font-mono text-sm text-fg outline-none focus:border-accent"
              />
            </div>
          ))}
        </div>
        {invalidQty ? <p className="text-[13px] text-danger">{invalidQty.materialName}: la cantidad no puede ser menor que lo ya entregado ({formatNumber(invalidQty.delivered)}).</p> : null}

        <label className="flex flex-col gap-1.5">
          <FieldLabel>Total informado por el proveedor (opcional)</FieldLabel>
          <TextInput mono inputMode="decimal" placeholder="Usa la suma de los precios" value={statedTotal} onChange={(e) => setStatedTotal(e.target.value)} />
          <span className="text-xs text-fg-3">Úsalo si el proveedor pasó un total sin precios por ítem. Reemplaza la suma de las líneas.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Motivo de la corrección</FieldLabel>
          <TextInput placeholder="Ej.: el corralón confirmó el precio" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="text-[13px] text-fg-3">Los valores anteriores quedan en el historial del pedido.</p>
      </div>
    </Sheet>
  );
}
