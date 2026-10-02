import { useEffect, useState } from "react";
import { Link2, Truck } from "lucide-react";
import type { DeliveryInterpretation } from "@/domain/assistant";
import { formatDate, formatNumber } from "@/domain/format";
import { DocChip } from "@/components/ui/DocChip";
import { cn } from "@/components/ui/cn";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { CardActions, CardShell, EditableValue, FieldBox, Outcome, parseQuantityInput } from "./parts";

interface Props {
  interpretation: DeliveryInterpretation;
  confirming: boolean;
  onChange: (next: DeliveryInterpretation) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeliveryCard({ interpretation: i, confirming, onChange, onConfirm, onCancel }: Props) {
  const desktop = useIsDesktop();
  const [editingAll, setEditingAll] = useState(false);
  const [field, setField] = useState<string | null>(null);
  const ordered = i.items.reduce((s, it) => s + it.ordered, 0);
  const after = i.items.reduce((s, it) => s + it.before + it.now, 0);
  const complete = after >= ordered;
  const flagged = (key: string) => i.flags.includes(key);
  const set = (key: keyof DeliveryInterpretation, value: string) =>
    onChange({ ...i, [key]: value, flags: i.flags.filter((f) => f !== key) });
  const setNow = (lineId: string, raw: string) => {
    const n = Math.max(0, parseQuantityInput(raw) ?? 0);
    onChange({ ...i, items: i.items.map((it) => (it.orderLineId === lineId ? { ...it, now: Math.min(n, Math.round((it.ordered - it.before) * 1000) / 1000) } : it)) });
  };

  const fieldProps = (key: string) => ({ editing: field === key, onEdit: () => setField(key) });
  const editor = (key: keyof DeliveryInterpretation, kind: "text" | "date" = "text") => (
    <EditableValue
      ariaLabel={key}
      value={String(i[key] ?? "")}
      display={kind === "date" ? formatDate(String(i[key])) : String(i[key] || "Sin número")}
      kind={kind}
      editing={field === key}
      onEditingChange={(e) => setField(e ? key : null)}
      onCommit={(v) => set(key, v)}
    />
  );

  return (
    <CardShell
      icon={Truck}
      title="Detecté una entrega"
      subtitle={desktop ? `${complete ? "Entrega completa" : "Entrega parcial"} del pedido ${i.orderNumber}` : `Pedido ${i.orderNumber} · ${i.supplierName}`}
      badge
      actions={
        <CardActions
          confirmLabel="Confirmar"
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
      <div className="flex flex-col gap-3.5 p-4 lg:gap-4 lg:p-5">
        <div className="flex gap-2.5">
          {desktop ? (
            <>
              <FieldBox label="Proveedor" className="w-[190px]" {...fieldProps("supplierName")}>
                {editor("supplierName")}
              </FieldBox>
              <FieldBox label="Pedido" mono className="w-[104px]" {...fieldProps("orderNumber")}>
                {editor("orderNumber")}
              </FieldBox>
            </>
          ) : null}
          <FieldBox label="Remito" mono flagged={flagged("remito")} className="flex-1 lg:w-[160px] lg:flex-none" {...fieldProps("remito")}>
            {editor("remito")}
          </FieldBox>
          <FieldBox label="Fecha" mono className="min-w-[124px] flex-1" {...fieldProps("date")}>
            {editor("date", "date")}
          </FieldBox>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-border">
          <div className="flex gap-2.5 bg-sunken px-3 py-2 text-xs font-medium text-fg-3 lg:gap-3 lg:px-3.5">
            <span className="flex-1">Material</span>
            {desktop ? (
              <>
                <span className="w-24 text-right">Pedido</span>
                <span className="w-24 text-right">Antes</span>
                <span className="w-24 text-right">Esta entrega</span>
                <span className="w-24 text-right">Pendiente</span>
              </>
            ) : (
              <>
                <span className="w-[52px] text-right">Llega</span>
                <span className="w-[52px] text-right">Pend.</span>
              </>
            )}
          </div>
          {i.items.map((it) => {
            const pending = it.ordered - it.before - it.now;
            const nowCell = editingAll ? (
              <QuantityInput label={`Cantidad entregada de ${it.material}`} value={it.now} onCommit={(raw) => setNow(it.orderLineId, raw)} />
            ) : (
              formatNumber(it.now)
            );
            return (
              <div key={it.orderLineId} className="flex items-center gap-2.5 border-t border-border px-3 py-2.5 lg:gap-3 lg:px-3.5 lg:py-[11px]">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-fg">{it.material}</span>
                  {desktop ? <span className="text-xs text-fg-3">Unidad: {it.unit}</span> : null}
                </div>
                {desktop ? (
                  <>
                    <span className="w-24 text-right font-mono text-sm text-fg">{formatNumber(it.ordered)}</span>
                    <span className="w-24 text-right font-mono text-sm text-fg">{formatNumber(it.before)}</span>
                    <span className="w-24 text-right font-mono text-sm font-semibold text-info">{nowCell}</span>
                    <span className="w-24 text-right font-mono text-sm text-fg">{formatNumber(pending)}</span>
                  </>
                ) : (
                  <>
                    <span className={cn("text-right font-mono text-sm font-semibold text-info", editingAll ? "w-16" : "w-[52px]")}>{nowCell}</span>
                    <span className="w-[52px] text-right font-mono text-sm text-fg">{formatNumber(pending)}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {i.document ? (
          <div className="flex items-center gap-3">
            <DocChip
              fileName={i.document.fileName}
              meta={desktop ? `${i.document.format === "pdf" ? "PDF" : "Foto"} · ${i.document.sizeLabel}` : `${i.document.format === "pdf" ? "PDF" : "Foto"} · comprobante de entrega`}
              format={i.document.format}
              className="flex-1 lg:flex-none"
            />
            <span className="hidden items-center gap-1.5 text-[13px] text-fg-2 lg:flex">
              <Link2 size={14} className="text-fg-3" />
              Se guardará como comprobante de entrega
            </span>
          </div>
        ) : null}

        <Outcome>
          {desktop
            ? `Al confirmar, el pedido ${i.orderNumber} pasará a ${complete ? "Entregado" : "Entrega parcial"} (${formatNumber(after)} de ${formatNumber(ordered)} unidades). El estado de pago no cambia.`
            : `Quedará en ${complete ? "Entregado" : "Entrega parcial"}. El pago no cambia.`}
        </Outcome>
      </div>
    </CardShell>
  );
}

/** Decimal-friendly quantity field ("6,5"); commits on blur/Enter. */
function QuantityInput({ label, value, onCommit }: { label: string; value: number; onCommit: (raw: string) => void }) {
  const [text, setText] = useState(formatNumber(value));
  useEffect(() => setText(formatNumber(value)), [value]);
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => e.key === "Enter" && onCommit(text)}
      className="h-9 w-full rounded-md border border-accent bg-surface px-2 text-right font-mono text-sm font-semibold text-info outline-none"
    />
  );
}
