import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import type { Payment, SupplierDetail } from "@/domain/types";
import { formatDate, formatMoney } from "@/domain/format";
import { useServices } from "@/services";
import { useInvalidateAll } from "@/queries";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { cn } from "../ui/cn";

/** Assigns an unallocated supplier payment to one of its open orders. */
export function AllocateSheet({ open, onClose, supplier, payment }: { open: boolean; onClose: () => void; supplier: SupplierDetail; payment?: Payment }) {
  const { assistant } = useServices();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const candidates = supplier.openOrderList.filter((o) => (o.pendingPayment ?? 0) > 0).sort((a, b) => a.date.localeCompare(b.date));
  const [selected, setSelected] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setSelected(candidates[0]?.id ?? "");
  }, [open]);

  if (!payment) return null;
  const order = candidates.find((o) => o.id === selected);

  const save = async () => {
    if (!order) return;
    setSaving(true);
    await assistant.confirm(`alloc:${payment.id}:manual`, {
      kind: "payment",
      supplierId: supplier.id,
      supplierName: supplier.name,
      amount: payment.amount,
      date: payment.date,
      method: payment.method,
      allocation: { type: "order", orderId: order.id, orderNumber: order.number },
      preview: { supplierBalanceBefore: supplier.balance, supplierBalanceAfter: supplier.balance },
      flags: [],
    });
    await invalidate();
    setSaving(false);
    onClose();
    toast(`Pago imputado al pedido ${order.number}`);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Imputar a un pedido"
      subtitle={`${formatMoney(payment.amount)} recibido el ${formatDate(payment.date)} · ${supplier.name}`}
      footer={
        <Button icon={Link2} size="lg" className="flex-1" disabled={!order} loading={saving} onClick={save}>
          {order ? `Imputar al pedido ${order.number}` : "Imputar"}
        </Button>
      }
    >
      <div className="flex flex-col gap-2 pb-4" role="radiogroup">
        {candidates.length === 0 ? <p className="text-sm text-fg-2">No hay pedidos con saldo pendiente para imputar.</p> : null}
        {candidates.map((o) => {
          const active = o.id === selected;
          const after = (o.pendingPayment ?? 0) - payment.amount;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelected(o.id)}
              className={cn("flex items-center gap-3 rounded-xl px-3.5 py-3 text-left", active ? "bg-accent-soft outline-[1.5px] -outline-offset-1 outline-accent" : "border border-border hover:bg-sunken")}
            >
              <span className={cn("size-5 shrink-0 rounded-full bg-surface", active ? "border-[6px] border-accent" : "border-[1.5px] border-border-strong")} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-medium text-fg">
                  Pedido {o.number} · <span className="font-mono text-[13px] text-fg-3">{formatDate(o.date)}</span>
                </span>
                <span className="text-[13px] text-fg-3">
                  Pendiente {formatMoney(o.pendingPayment ?? 0)} · {after <= 0 ? "quedaría pagado" : `quedaría ${formatMoney(after)}`}
                </span>
              </span>
            </button>
          );
        })}
        <p className="pt-2 text-[13px] text-fg-3">El saldo del proveedor no cambia: el pago ya estaba descontado. Solo se asigna a un pedido.</p>
      </div>
    </Sheet>
  );
}
