import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { DeliveryInterpretation, PaymentInterpretation } from "@/domain/assistant";
import type { OrderDetail, PaymentMethod } from "@/domain/types";
import { formatMoney, formatNumber, paymentMethodLabel } from "@/domain/format";
import { useServices } from "@/services";
import { useInvalidateAll } from "@/queries";
import { Button } from "../ui/Button";
import { FieldLabel, TextInput } from "../ui/Fields";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";

function parseMoney(raw: string): number {
  return Number(raw.replace(/[^\d,]/g, "").replace(",", ".")) || 0;
}

export function RegisterDeliverySheet({ order, open, onClose, today }: { order: OrderDetail; open: boolean; onClose: () => void; today: string }) {
  const { assistant } = useServices();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const pendingLines = order.lines.filter((l) => l.delivered < l.quantity);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [remito, setRemito] = useState("");
  const [date, setDate] = useState(today);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setQty(Object.fromEntries(pendingLines.map((l) => [l.id, l.quantity - l.delivered])));
      setRemito("");
      setDate(today);
    }
  }, [open]);

  const save = async () => {
    setSaving(true);
    const interpretation: DeliveryInterpretation = {
      kind: "delivery",
      supplierName: order.supplier.name,
      orderId: order.id,
      orderNumber: order.number,
      remito,
      date,
      items: pendingLines.map((l) => ({ orderLineId: l.id, material: l.materialName, unit: l.unit, ordered: l.quantity, before: l.delivered, now: qty[l.id] ?? 0 })),
      flags: [],
    };
    await assistant.confirm(`manual-delivery-${order.id}`, interpretation);
    await invalidate();
    setSaving(false);
    onClose();
    toast("Entrega registrada");
  };

  const total = Object.values(qty).reduce((s, n) => s + n, 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Registrar entrega"
      subtitle={`Pedido ${order.number} · ${order.supplier.name}`}
      footer={
        <Button icon={Check} size="lg" className="flex-1" loading={saving} disabled={total <= 0} onClick={save}>
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
                  inputMode="numeric"
                  value={qty[l.id] ?? 0}
                  onChange={(e) => setQty({ ...qty, [l.id]: Math.min(Number(e.target.value.replace(/\D/g, "")) || 0, l.quantity - l.delivered) })}
                  className="h-10 w-24 rounded-lg border border-border-strong bg-surface px-2 text-right font-mono text-sm font-semibold text-info outline-none focus:border-accent"
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
        <p className="text-[13px] text-fg-3">El estado de pago no cambia al registrar una entrega.</p>
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
  const { assistant } = useServices();
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

  const value = parseMoney(amount);
  const order = orders.find((o) => o.id === allocation);

  const save = async () => {
    setSaving(true);
    const pendingAfter = order?.pendingPayment !== undefined && order?.pendingPayment !== null ? Math.max(order.pendingPayment - value, 0) : undefined;
    const interpretation: PaymentInterpretation = {
      kind: "payment",
      supplierId: supplier.id,
      supplierName: supplier.name,
      amount: value,
      date,
      method,
      allocation: order ? { type: "order", orderId: order.id, orderNumber: order.number } : { type: "unallocated" },
      preview: { orderPendingBefore: order?.pendingPayment ?? undefined, orderPendingAfter: pendingAfter, supplierBalanceBefore: balance, supplierBalanceAfter: balance - value },
      flags: [],
    };
    await assistant.confirm(`manual-payment-${supplier.id}`, interpretation);
    await invalidate();
    setSaving(false);
    onClose();
    toast("Pago registrado");
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
      </div>
    </Sheet>
  );
}
