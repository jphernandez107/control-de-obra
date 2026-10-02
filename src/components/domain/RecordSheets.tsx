import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { OrderDetail, PaymentMethod } from "@/domain/types";
import { formatMoney, formatNumber, paymentMethodLabel, parseMoneyInput } from "@/domain/format";
import { useServices } from "@/services";
import { errorMessage } from "@/services/api/client";
import { useInvalidateAll } from "@/queries";
import { parseQuantityInput } from "@/features/assistant/cards/parts";
import { Button } from "../ui/Button";
import { FieldLabel, TextInput } from "../ui/Fields";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";

export function RegisterDeliverySheet({ order, open, onClose, today }: { order: OrderDetail; open: boolean; onClose: () => void; today: string }) {
  const { deliveries } = useServices();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const pendingLines = order.lines.filter((l) => l.delivered < l.quantity);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [remito, setRemito] = useState("");
  const [date, setDate] = useState(today);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setQty(Object.fromEntries(pendingLines.map((l) => [l.id, formatNumber(l.quantity - l.delivered)])));
      setRemito("");
      setDate(today);
    }
  }, [open]);

  const amounts = pendingLines.map((l) => ({ line: l, value: parseQuantityInput(qty[l.id] ?? "") ?? 0 }));
  const over = amounts.find(({ line, value }) => value > line.quantity - line.delivered + 1e-9);

  const save = async () => {
    setSaving(true);
    try {
      await deliveries.create({
        orderId: order.id,
        date,
        reference: remito.trim() || null,
        items: amounts.filter((a) => a.value > 0).map((a) => ({ orderItemId: a.line.id, quantity: a.value })),
      });
      await invalidate();
      onClose();
      toast("Entrega registrada");
    } catch (error) {
      toast(errorMessage(error, "No se pudo registrar la entrega."), "info");
    } finally {
      setSaving(false);
    }
  };

  const total = amounts.reduce((s, a) => s + a.value, 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Registrar entrega"
      subtitle={`Pedido ${order.number} · ${order.supplier.name}`}
      footer={
        <Button icon={Check} size="lg" className="flex-1" loading={saving} disabled={total <= 0 || Boolean(over)} onClick={save}>
          Confirmar entrega
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pb-4">
        {pendingLines.length === 0 ? (
          <p className="text-sm text-fg-2">Este pedido ya está entregado completo.</p>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-border">
            <div className="flex gap-3 bg-sunken px-3 py-2 text-xs font-medium text-fg-3">
              <span className="flex-1">Material</span>
              <span className="w-16 text-right">Pend.</span>
              <span className="w-24 text-right">Llega</span>
            </div>
            {pendingLines.map((l) => (
              <div key={l.id} className="flex items-center gap-3 border-t border-border px-3 py-2">
                <span className="flex-1 text-sm font-medium text-fg">{l.materialName}</span>
                <span className="w-16 text-right font-mono text-sm text-fg-2">{formatNumber(l.quantity - l.delivered)}</span>
                <input
                  aria-label={`Cantidad que llega de ${l.materialName}`}
                  inputMode="decimal"
                  value={qty[l.id] ?? ""}
                  onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
                  className={`h-10 w-24 rounded-lg border bg-surface px-2 text-right font-mono text-sm font-semibold text-info outline-none focus:border-accent ${over?.line.id === l.id ? "border-danger" : "border-border-strong"}`}
                />
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel>Remito</FieldLabel>
            <TextInput mono placeholder="0000-00000000" value={remito} onChange={(e) => setRemito(e.target.value)} />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel>Fecha</FieldLabel>
            <TextInput mono type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        {over ? (
          <p className="text-[13px] text-danger">
            {over.line.materialName}: solo faltan {formatNumber(over.line.quantity - over.line.delivered)} {over.line.unit}. Si llegó de más, regístralo como otro pedido.
          </p>
        ) : (
          <p className="text-[13px] text-fg-3">El estado de pago no cambia al registrar una entrega.</p>
        )}
      </div>
    </Sheet>
  );
}

export function RegisterPaymentSheet({
  open,
  onClose,
  today,
  supplier,
  balance,
  orders,
  defaultOrderId,
}: {
  open: boolean;
  onClose: () => void;
  today: string;
  supplier: { id: string; name: string };
  balance: number;
  orders: { id: string; number: string; pendingPayment: number | null; deliveryStatus: string }[];
  defaultOrderId?: string;
}) {
  const { payments } = useServices();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const [allocation, setAllocation] = useState<string>("unallocated");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("transferencia");
  const [date, setDate] = useState(today);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const initial = defaultOrderId ?? "unallocated";
    setAllocation(initial);
    const order = orders.find((o) => o.id === initial);
    setAmount(order?.pendingPayment ? formatMoney(order.pendingPayment) : "");
    setMethod("transferencia");
    setDate(today);
  }, [open]);

  const value = parseMoneyInput(amount) ?? 0;
  const order = orders.find((o) => o.id === allocation);
  // Only the order's known balance is allocated; any excess stays on the current account.
  const allocated = order ? (order.pendingPayment === null ? value : Math.min(value, order.pendingPayment)) : 0;
  const excess = value - allocated;

  const save = async () => {
    setSaving(true);
    try {
      await payments.create({
        supplierId: supplier.id,
        date,
        amount: value,
        method,
        allocations: order && allocated > 0 ? [{ orderId: order.id, amount: allocated }] : [],
      });
      await invalidate();
      onClose();
      toast("Pago registrado");
    } catch (error) {
      toast(errorMessage(error, "No se pudo registrar el pago."), "info");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Registrar pago"
      subtitle={supplier.name}
      footer={
        <Button icon={Check} size="lg" className="flex-1" loading={saving} disabled={value <= 0} onClick={save}>
          Confirmar pago
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pb-4">
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Importe</FieldLabel>
          <TextInput mono inputMode="decimal" placeholder="$0" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => value > 0 && setAmount(formatMoney(value))} className="text-xl font-semibold" />
        </label>
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Imputación</FieldLabel>
          <select
            value={allocation}
            onChange={(e) => {
              setAllocation(e.target.value);
              const o = orders.find((x) => x.id === e.target.value);
              if (o?.pendingPayment) setAmount(formatMoney(o.pendingPayment));
            }}
            className="h-12 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-base text-fg outline-none focus:border-accent"
          >
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                Pedido {o.number}
                {o.pendingPayment !== null ? ` · pendiente ${formatMoney(o.pendingPayment)}` : ""}
              </option>
            ))}
            <option value="unallocated">Pago a cuenta corriente (sin imputar)</option>
          </select>
        </label>
        <div className="flex gap-2.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel>Medio</FieldLabel>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className="h-12 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-base text-fg outline-none focus:border-accent">
              {(Object.keys(paymentMethodLabel) as PaymentMethod[]).map((m) => (
                <option key={m} value={m}>
                  {paymentMethodLabel[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel>Fecha</FieldLabel>
            <TextInput mono type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <div className="flex items-center gap-2 rounded-[10px] bg-sunken px-3 py-2.5 text-[13px] text-fg-2">
          <span className="flex-1">Saldo del proveedor</span>
          <span className="font-mono text-fg-3">{formatMoney(balance)}</span>
          <span className="text-fg-3">→</span>
          <span className="font-mono font-semibold text-fg">{formatMoney(balance - value)}</span>
        </div>
        {order && excess > 0 && value > 0 ? (
          <p className="text-[13px] text-fg-3">
            El pago supera el saldo del pedido {order.number}: {formatMoney(excess)} quedarán sin imputar en la cuenta corriente.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
