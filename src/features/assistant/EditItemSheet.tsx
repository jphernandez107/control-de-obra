import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, Lock, Minus, Plus, Trash2 } from "lucide-react";
import type { InterpretedOrderItem, OrderInterpretation } from "@/domain/assistant";
import { formatMoney, formatNumber } from "@/domain/format";
import { Button } from "@/components/ui/Button";
import { FieldLabel, TextInput } from "@/components/ui/Fields";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/components/ui/cn";
import { useMaterialOptions, useUnits } from "@/queries";
import { parseMoneyInput, parseQuantityInput } from "./cards/parts";

const FALLBACK_UNITS = ["barras", "u", "bolsas", "m³", "mallas", "kg", "m", "m²", "l"];

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function EditItemSheet({
  open,
  index,
  interpretation,
  onClose,
  onSave,
}: {
  open: boolean;
  index: number;
  interpretation: OrderInterpretation;
  onClose: () => void;
  onSave: (items: InterpretedOrderItem[]) => void;
}) {
  const listId = useId();
  const catalog = useMaterialOptions();
  const units = useUnits();
  const item = interpretation.items[index];
  const [draft, setDraft] = useState<InterpretedOrderItem | undefined>(item);
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");

  useEffect(() => {
    if (open && item) {
      setDraft(item);
      setPrice(item.unitPrice === null ? "" : formatMoney(item.unitPrice));
      setQuantity(formatNumber(item.quantity));
    }
  }, [open, item]);

  if (!draft) return null;
  const unitPrice = parseMoneyInput(price);
  const qty = parseQuantityInput(quantity) ?? 0;
  const amount = unitPrice === null ? null : Math.round(unitPrice * qty);
  const options = catalog.data ?? [];
  const exact = options.find((m) => normalize(m.name) === normalize(draft.material) || m.aliases.some((a) => normalize(a) === normalize(draft.material)));
  const chosen = draft.materialId ? options.find((m) => m.id === draft.materialId) : undefined;
  const unitLabels = [...new Set([draft.unit, ...(units.data?.map((u) => u.label) ?? FALLBACK_UNITS)])];

  const pick = (m: { id: string; name: string; unit: string }) => setDraft({ ...draft, materialId: m.id, material: m.name, unit: m.unit, match: "matched", candidates: undefined });
  const typeName = (name: string) => {
    const match = options.find((m) => normalize(m.name) === normalize(name));
    setDraft(match ? { ...draft, materialId: match.id, material: match.name, unit: match.unit, match: "matched", candidates: undefined } : { ...draft, material: name, materialId: null, match: "new", candidates: undefined });
  };
  // The printed size (12 m per barra) only describes the original purchase unit.
  const unitSize = item && draft.unit === item.unit ? draft.unitSize : undefined;
  const save = () => onSave(interpretation.items.map((it, i) => (i === index ? { ...draft, quantity: qty, unitPrice, unitSize } : it)));
  const remove = () => onSave(interpretation.items.filter((_, i) => i !== index));

  let hint: React.ReactNode;
  if (draft.match === "suggested" && chosen) hint = <span className="text-xs text-warning">No estoy seguro: ¿«{draft.mention ?? draft.material}» es {chosen.name}? Elige una opción para confirmarlo.</span>;
  else if (draft.match === "new" && !exact) hint = <span className="text-xs text-fg-3">Material nuevo: se agregará al catálogo al confirmar el pedido.</span>;
  else hint = <span className="text-xs text-fg-3">Se suma a «{draft.material}» en Materiales y cómputo.</span>;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Editar ítem ${index + 1} de ${interpretation.items.length}`}
      subtitle={`${interpretation.number ? `Pedido ${interpretation.number} · ` : ""}${interpretation.supplierName || "Proveedor sin indicar"}`}
      footer={
        <>
          <Button variant="danger-ghost" icon={Trash2} size="lg" onClick={remove} disabled={interpretation.items.length <= 1}>
            Quitar ítem
          </Button>
          <Button icon={Check} size="lg" className="flex-1" onClick={save} disabled={!draft.material.trim() || qty <= 0}>
            Guardar cambios
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 pb-6 lg:pb-2">
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Material</FieldLabel>
          <span className="relative">
            <TextInput list={listId} value={draft.material} onChange={(e) => typeName(e.target.value)} className="pr-10 font-medium" />
            <ChevronDown size={18} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-3" />
          </span>
          <datalist id={listId}>
            {options.map((m) => (
              <option key={m.id} value={m.name} />
            ))}
          </datalist>
          {hint}
        </label>
        {draft.match === "suggested" && draft.candidates?.length ? (
          <div className="flex flex-wrap gap-2">
            {draft.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick({ id: c.id, name: c.name, unit: c.unit ?? draft.unit })}
                className={cn("inline-flex h-9 items-center rounded-[17px] border px-3 text-[13px]", c.id === draft.materialId ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-2")}
              >
                {c.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setDraft({ ...draft, material: draft.mention ?? draft.material, materialId: null, match: "new", candidates: undefined })}
              className="inline-flex h-9 items-center rounded-[17px] border border-dashed border-border-strong px-3 text-[13px] text-fg-2"
            >
              Es otro: crear material nuevo
            </button>
          </div>
        ) : null}
        <div className="flex gap-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel>Cantidad</FieldLabel>
            <div className="flex h-12 items-center rounded-[10px] outline-2 -outline-offset-1 outline-accent">
              <button type="button" aria-label="Restar" className="flex h-full w-12 items-center justify-center text-fg-2" onClick={() => setQuantity(formatNumber(Math.max(1, qty - 1)))}>
                <Minus size={18} />
              </button>
              <input
                aria-label="Cantidad"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-center font-mono text-lg font-semibold text-fg outline-none"
              />
              <button type="button" aria-label="Sumar" className="flex h-full w-12 items-center justify-center text-fg-2" onClick={() => setQuantity(formatNumber(qty + 1))}>
                <Plus size={18} />
              </button>
            </div>
          </div>
          <label className="flex w-[130px] shrink-0 flex-col gap-1.5">
            <FieldLabel>Unidad</FieldLabel>
            <span className="relative">
              <select
                value={draft.unit}
                onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                className="h-12 w-full appearance-none rounded-[10px] border border-border-strong bg-surface px-3 text-base font-medium text-fg outline-none focus:border-accent"
              >
                {unitLabels.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
              <ChevronDown size={18} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-3" />
            </span>
          </label>
        </div>
        {unitSize ? (
          <span className="-mt-2 font-mono text-xs text-fg-3">
            {formatNumber(unitSize.quantity)} {unitSize.unit} c/u · equivale a {formatNumber(qty * unitSize.quantity)} {unitSize.unit}
          </span>
        ) : null}
        <div className="flex gap-2.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel>Precio unitario</FieldLabel>
            <TextInput mono inputMode="decimal" placeholder="Sin precio" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={() => unitPrice !== null && setPrice(formatMoney(unitPrice))} />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel>Importe</FieldLabel>
            <span className="relative">
              <TextInput mono disabled value={amount === null ? "—" : formatMoney(amount)} className="pr-10" />
              <Lock size={18} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-3" />
            </span>
          </label>
        </div>
      </div>
    </Sheet>
  );
}
