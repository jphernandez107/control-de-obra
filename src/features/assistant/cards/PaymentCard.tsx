import { useRef, useState } from "react";
import { ArrowRight, FilePlus, Wallet } from "lucide-react";
import type { PaymentInterpretation } from "@/domain/assistant";
import type { PaymentMethod, StatusTag } from "@/domain/types";
import { formatDate, formatMoney, paymentMethodLabel } from "@/domain/format";
import { DocChip } from "@/components/ui/DocChip";
import { Pill } from "@/components/ui/Pill";
import { useOrders } from "@/queries";
import { useServices } from "@/services";
import { errorMessage } from "@/services/api/client";
import { useToast } from "@/components/ui/Toast";
import { fileToAttachment, isSupportedAttachment } from "../AssistantProvider";
import { CardActions, CardShell, EditableValue, KVRow, VerifyFlag, parseMoneyInput } from "./parts";

interface Props {
  interpretation: PaymentInterpretation;
  confirming: boolean;
  onChange: (next: PaymentInterpretation) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PaymentCard({ interpretation: i, confirming, onChange, onConfirm, onCancel }: Props) {
  const [field, setField] = useState<string | null>(null);
  const [editingAll, setEditingAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { documents } = useServices();
  const toast = useToast();
  const orders = useOrders();
  const supplierOrders = (orders.data?.orders ?? []).filter((o) => o.supplier.id === i.supplierId && ((o.pendingPayment ?? 0) > 0 || (i.allocation.type === "order" && o.id === i.allocation.orderId)));
  const allocatedOrder = i.allocation.type === "order" ? orders.data?.orders.find((o) => o.id === (i.allocation as { orderId: string }).orderId) : undefined;

  const recompute = (next: PaymentInterpretation): PaymentInterpretation => {
    const order = next.allocation.type === "order" ? orders.data?.orders.find((o) => o.id === (next.allocation as { orderId: string }).orderId) : undefined;
    const before = order?.pendingPayment ?? undefined;
    const after = before !== undefined ? Math.max(before - next.amount, 0) : undefined;
    const unallocatedAmount = next.allocation.type === "unallocated" ? next.amount : before !== undefined ? Math.max(next.amount - before, 0) : 0;
    const tags: StatusTag[] = order
      ? [order.delivery.status === "entregado" ? "entregado" : order.delivery.status === "parcial" ? "entrega_parcial" : "entrega_pendiente", after === 0 ? "pagado" : "pago_parcial"]
      : ["pago_sin_imputar"];
    return {
      ...next,
      preview: {
        orderPendingBefore: before,
        orderPendingAfter: after,
        supplierBalanceBefore: next.preview.supplierBalanceBefore,
        supplierBalanceAfter: next.existingPaymentId ? next.preview.supplierBalanceBefore : next.preview.supplierBalanceBefore - next.amount,
        unallocatedAmount,
        resultingTags: tags,
      },
    };
  };

  const isEditing = (key: string) => editingAll || field === key;
  const setEditing = (key: string) => (e: boolean) => setField(e ? key : null);
  const clearFlag = (key: string) => i.flags.filter((f) => f !== key);

  const allocationLabel =
    i.allocation.type === "order" ? `Pedido ${i.allocation.orderNumber}` : i.allocation.type === "split" ? `Repartido en ${i.allocation.parts.length} pedidos` : "Sin imputar (cuenta corriente)";
  const p = i.preview;

  return (
    <CardShell
      icon={Wallet}
      title={i.existingPaymentId ? "Imputar un pago" : "Detecté un pago"}
      subtitle="Revisa antes de guardar"
      badge
      actions={
        <CardActions
          validation={i.validation}
          confirmLabel={i.existingPaymentId ? "Confirmar imputación" : "Confirmar pago"}
          onConfirm={() => {
            setEditingAll(false);
            onConfirm();
          }}
          onEdit={() => setEditingAll((v) => !v)}
          onCancel={onCancel}
          confirming={confirming}
          editing={editingAll}
        />
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 lg:p-5">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs text-fg-3">
            Importe {i.flags.includes("amount") ? <VerifyFlag /> : null}
          </span>
          <EditableValue
            ariaLabel="Importe"
            value={i.amount}
            kind="money"
            display={<span className="font-mono text-[26px] font-semibold tracking-[-1px] text-fg">{formatMoney(i.amount)}</span>}
            editing={isEditing("amount")}
            onEditingChange={setEditing("amount")}
            inputClassName="font-mono text-xl max-w-[220px]"
            onCommit={(v) => {
              const amount = parseMoneyInput(v);
              if (amount && amount > 0) onChange(recompute({ ...i, amount, flags: clearFlag("amount") }));
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <KVRow label="Proveedor" editing={false} onEdit={() => setEditingAll(true)}>
            {i.supplierName}
          </KVRow>
          <KVRow label="Fecha" mono editing={isEditing("date")} onEdit={() => setField("date")}>
            <EditableValue ariaLabel="Fecha" value={i.date} kind="date" display={formatDate(i.date)} editing={isEditing("date")} onEditingChange={setEditing("date")} onCommit={(v) => v && onChange({ ...i, date: v })} />
          </KVRow>
          <KVRow label="Medio" editing={isEditing("method")} onEdit={() => setField("method")}>
            <EditableValue
              ariaLabel="Medio de pago"
              value={i.method}
              display={paymentMethodLabel[i.method]}
              options={(Object.keys(paymentMethodLabel) as PaymentMethod[]).map((m) => ({ value: m, label: paymentMethodLabel[m] }))}
              editing={isEditing("method")}
              onEditingChange={setEditing("method")}
              onCommit={(v) => onChange({ ...i, method: v as PaymentMethod })}
            />
          </KVRow>
          <KVRow label="Imputación" editing={isEditing("allocation")} onEdit={() => setField("allocation")}>
            <EditableValue
              ariaLabel="Imputación"
              value={i.allocation.type === "order" ? i.allocation.orderId : i.allocation.type}
              display={allocationLabel}
              options={[
                ...(i.allocation.type === "split" ? [{ value: "split", label: allocationLabel }] : []),
                ...supplierOrders.map((o) => ({ value: o.id, label: `Pedido ${o.number} · saldo ${o.pendingPayment === null ? "a confirmar" : formatMoney(o.pendingPayment)}` })),
                ...(i.existingPaymentId ? [] : [{ value: "unallocated", label: "Sin imputar (cuenta corriente)" }]),
              ]}
              editing={isEditing("allocation")}
              onEditingChange={setEditing("allocation")}
              onCommit={(v) => {
                if (v === "split") return;
                const order = supplierOrders.find((o) => o.id === v);
                onChange(recompute({ ...i, allocation: order ? { type: "order", orderId: order.id, orderNumber: order.number } : { type: "unallocated" } }));
              }}
            />
          </KVRow>
        </div>

        <div className="flex flex-col gap-2 rounded-[10px] bg-sunken p-3">
          <span className="text-xs font-semibold text-fg-2">Cómo queda</span>
          {i.allocation.type === "order" && p.orderPendingBefore !== undefined ? (
            <EffectRow label={`Pedido ${i.allocation.orderNumber} · pendiente`} from={p.orderPendingBefore} to={p.orderPendingAfter ?? 0} />
          ) : null}
          {i.allocation.type === "split"
            ? i.allocation.parts.map((part) => (
                <div key={part.orderId} className="flex items-center gap-2">
                  <span className="flex-1 text-[13px] text-fg-2">Al pedido {part.orderNumber}</span>
                  <span className="font-mono text-[13px] font-semibold text-fg">{formatMoney(part.amount)}</span>
                </div>
              ))
            : null}
          <EffectRow label="Saldo del proveedor" from={p.supplierBalanceBefore} to={p.supplierBalanceAfter} />
          {p.unallocatedAmount && i.allocation.type !== "unallocated" ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[13px] text-fg-2">Queda sin imputar</span>
              <span className="font-mono text-[13px] font-semibold text-ai">{formatMoney(p.unallocatedAmount)}</span>
            </div>
          ) : null}
          {p.resultingTags?.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-fg-3">{i.allocation.type === "order" ? `Pedido ${i.allocation.orderNumber}:` : "Quedará como:"}</span>
              {p.resultingTags.map((t) => (
                <Pill key={t} tag={t} />
              ))}
            </div>
          ) : null}
          {allocatedOrder === undefined && i.allocation.type === "unallocated" && !i.existingPaymentId ? (
            <span className="text-xs leading-[17px] text-fg-3">Reduce el saldo del proveedor; podrás imputarlo a un pedido más adelante.</span>
          ) : null}
        </div>

        {i.document ? (
          <DocChip fileName={i.document.fileName} meta={`Comprobante de pago · ${i.document.sizeLabel}`} format={i.document.format} wide />
        ) : (
          <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-2.5 rounded-[10px] border border-border-strong px-3 py-2.5 text-left hover:bg-sunken">
            <FilePlus size={16} className="text-fg-2" />
            <span className="flex-1 text-[13px] text-fg-2">Sin comprobante de pago</span>
            <span className="text-[13px] font-semibold text-accent">{uploading ? "Subiendo…" : "Adjuntar"}</span>
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (!isSupportedAttachment(file)) {
              toast("Formato no soportado. Adjunta un PDF o una foto.", "info");
              return;
            }
            setUploading(true);
            try {
              const uploaded = await documents.upload(file, "payment_proof");
              onChange({ ...i, document: { ...fileToAttachment(file), documentId: uploaded.id, url: uploaded.url } });
            } catch (error) {
              toast(errorMessage(error, "No se pudo subir el comprobante."), "info");
            } finally {
              setUploading(false);
            }
          }}
        />
      </div>
    </CardShell>
  );
}

function EffectRow({ label, from, to }: { label: string; from: number; to: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-[13px] text-fg-2">{label}</span>
      <span className="font-mono text-[13px] text-fg-3">{formatMoney(from)}</span>
      <ArrowRight size={12} className="text-fg-3" />
      <span className="font-mono text-[13px] font-semibold text-fg">{formatMoney(to)}</span>
    </div>
  );
}
