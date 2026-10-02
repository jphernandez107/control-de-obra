import { useState } from "react";
import { ClipboardList } from "lucide-react";
import type { InterpretedOrderItem, OrderInterpretation } from "@/domain/assistant";
import { formatDate, formatMoney, formatNumber, purchaseModeLabel } from "@/domain/format";
import type { PurchaseMode } from "@/domain/types";
import { DocChip } from "@/components/ui/DocChip";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { EditItemSheet } from "../EditItemSheet";
import { CardActions, CardShell, EditableValue, FieldBox, KVRow, Outcome, VerifyFlag } from "./parts";

interface Props {
  interpretation: OrderInterpretation;
  confirming: boolean;
  onChange: (next: OrderInterpretation) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const amountOf = (it: InterpretedOrderItem) => (it.unitPrice === null ? null : Math.round(it.unitPrice * it.quantity));

export function OrderCard({ interpretation: i, confirming, onChange, onConfirm, onCancel }: Props) {
  const desktop = useIsDesktop();
  const [field, setField] = useState<string | null>(null);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const amounts = i.items.map(amountOf);
  const total = i.statedTotal ?? (amounts.every((a) => a !== null) ? amounts.reduce((s: number, a) => s + (a ?? 0), 0) : null);
  const flagged = (key: string) => i.flags.includes(key);
  const set = (key: keyof OrderInterpretation, value: string) => onChange({ ...i, [key]: value, flags: i.flags.filter((f) => f !== key) });

  const fields: { key: keyof OrderInterpretation; label: string; mono?: boolean; kind?: "text" | "date"; display: string; options?: { value: string; label: string }[] }[] = [
    { key: "supplierName", label: "Proveedor", display: i.supplierName ? `${i.supplierName}${i.supplierMatch === "new" ? " (nuevo)" : ""}` : "Sin indicar" },
    { key: "number", label: "Pedido", mono: true, display: i.number ? `N.º ${i.number}` : "Sin número" },
    { key: "date", label: "Fecha", mono: true, kind: "date", display: formatDate(i.date) },
    { key: "orderedBy", label: "Pedido por", display: i.orderedBy || "Sin indicar" },
    {
      key: "mode",
      label: "Modalidad",
      display: purchaseModeLabel[i.mode],
      options: (Object.keys(purchaseModeLabel) as PurchaseMode[]).map((m) => ({ value: m, label: purchaseModeLabel[m] })),
    },
  ];

  const editorFor = (f: (typeof fields)[number]) => (
    <EditableValue
      ariaLabel={f.label}
      value={String(i[f.key])}
      display={f.display}
      kind={f.kind}
      options={f.options}
      editing={field === f.key}
      onEditingChange={(e) => setField(e ? f.key : null)}
      onCommit={(v) => set(f.key, v)}
    />
  );

  return (
    <CardShell
      icon={ClipboardList}
      title="Detecté un pedido"
      subtitle="Revisa antes de guardar"
      badge
      actions={<CardActions validation={i.validation} confirmLabel="Confirmar pedido" onConfirm={onConfirm} onEdit={() => setEditIndex(0)} onCancel={onCancel} confirming={confirming} />}
    >
      <div className="flex flex-col gap-2 px-4 pt-3 pb-3.5 lg:gap-4 lg:p-5">
        {desktop ? (
          <div className="grid grid-cols-3 gap-2.5">
            {fields.map((f) => (
              <FieldBox key={f.key} label={f.label} mono={f.mono} flagged={flagged(f.key)} editing={field === f.key} onEdit={() => setField(f.key)}>
                {editorFor(f)}
              </FieldBox>
            ))}
            {flagged("precios") ? (
              <div className="flex items-end pb-2.5">
                <span className="flex items-center gap-1.5 text-xs text-fg-3">
                  <VerifyFlag /> Precios del último pedido
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          fields.map((f) => (
            <KVRow key={f.key} label={f.label} mono={f.mono} flagged={flagged(f.key)} editing={field === f.key} onEdit={() => setField(f.key)}>
              {editorFor(f)}
            </KVRow>
          ))
        )}

        <div className="mt-1 overflow-hidden rounded-[10px] border border-border lg:mt-0">
          {desktop ? (
            <div className="flex gap-3 bg-sunken px-3.5 py-2 text-xs font-medium text-fg-3">
              <span className="flex-1">Material</span>
              <span className="w-28 text-right">Cantidad</span>
              <span className="w-28 text-right">P. unitario</span>
              <span className="w-28 text-right">Importe</span>
            </div>
          ) : null}
          {i.items.map((it, idx) => (
            <button
              key={it.id}
              type="button"
              onClick={() => setEditIndex(idx)}
              className="flex w-full items-center gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-sunken lg:gap-3 lg:border-t lg:border-b-0 lg:px-3.5 lg:first:border-t-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                  {it.material}
                  {it.match === "suggested" ? <VerifyFlag variant="pill" /> : null}
                  {it.match === "new" ? <span className="rounded-md bg-ai-soft px-1.5 py-0.5 text-[11px] font-medium text-ai">Material nuevo</span> : null}
                </span>
                {it.match === "suggested" && it.mention ? (
                  <span className="text-xs text-warning">Dijiste «{it.mention}» · toca para confirmar</span>
                ) : it.unitSize ? (
                  <span className="font-mono text-xs text-fg-3">
                    {formatNumber(it.unitSize.quantity)} {it.unitSize.unit} c/u · {formatNumber(it.quantity * it.unitSize.quantity)} {it.unitSize.unit}
                  </span>
                ) : it.spec ? (
                  <span className="font-mono text-xs text-fg-3">{it.spec}</span>
                ) : null}
              </span>
              {desktop ? (
                <>
                  <span className="w-28 text-right font-mono text-sm font-medium text-fg">
                    {formatNumber(it.quantity)} {it.unit}
                  </span>
                  <span className="w-28 text-right font-mono text-sm text-fg-2">{it.unitPrice === null ? "—" : formatMoney(it.unitPrice)}</span>
                  <span className="w-28 text-right font-mono text-sm text-fg">{amounts[idx] === null ? "—" : formatMoney(amounts[idx]!)}</span>
                </>
              ) : (
                <span className="flex flex-col items-end gap-0.5">
                  <span className="font-mono text-sm font-medium text-fg">
                    {formatNumber(it.quantity)} {it.unit}
                  </span>
                  <span className="font-mono text-xs text-fg-3">{amounts[idx] === null ? "sin precio" : formatMoney(amounts[idx]!)}</span>
                </span>
              )}
            </button>
          ))}
          <div className="flex items-center gap-2.5 border-t border-border bg-sunken px-3 py-2.5 lg:px-3.5">
            <span className="flex-1 text-[13px] text-fg-2">{i.statedTotal != null ? "Total informado" : "Total"}</span>
            <span className="font-mono text-base font-semibold text-fg">{total === null ? "A confirmar" : formatMoney(total)}</span>
          </div>
        </div>

        {i.document && desktop ? (
          <DocChip fileName={i.document.fileName} meta={`${i.document.format === "pdf" ? "PDF" : "Foto"} · ${i.document.sizeLabel}`} format={i.document.format} className="self-start" />
        ) : null}

        <div className="mt-1 lg:mt-0">
          <Outcome>
            Quedará como Pendiente de entrega y Sin pagos. {i.document ? "El comprobante se adjunta al pedido." : "Puedes adjuntar el comprobante después."}
          </Outcome>
        </div>
      </div>
      <EditItemSheet
        open={editIndex !== null}
        index={editIndex ?? 0}
        interpretation={i}
        onClose={() => setEditIndex(null)}
        onSave={(items) => {
          onChange({ ...i, items, flags: i.flags.filter((f) => f !== "precios" && (f !== "items" || items.some((x) => x.match === "suggested"))) });
          setEditIndex(null);
        }}
      />
    </CardShell>
  );
}
