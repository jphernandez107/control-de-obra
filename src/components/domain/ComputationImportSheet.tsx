import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { ComputationPreview, ComputationPreviewRow } from "@/services/types";
import { formatNumber } from "@/domain/format";
import { useImportComputation } from "@/queries";
import { errorMessage } from "@/services/api/client";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { cn } from "../ui/cn";

/** Selected material per row; `confirmed` is false until a weak match is resolved by the user. */
type Choice = { materialId: string | null; confirmed: boolean };

/**
 * Review step of a computation upload: shows how each row matched the
 * catalog. Weak matches must be resolved (existing material or new) before saving.
 */
export function ComputationImportSheet({ preview, onClose }: { preview: ComputationPreview | null; onClose: () => void }) {
  const importComputation = useImportComputation();
  const toast = useToast();
  const [choices, setChoices] = useState<Record<number, Choice>>({});

  useEffect(() => {
    if (preview) setChoices(Object.fromEntries(preview.rows.map((r) => [r.line, { materialId: r.match === "new" ? null : r.materialId, confirmed: r.match !== "suggested" }])));
  }, [preview]);

  if (!preview) return null;
  const rows = preview.rows;
  const resolved = (r: ComputationPreviewRow) => choices[r.line]?.confirmed ?? false;
  const usable = rows.filter((r) => !r.problem);
  const pending = usable.filter((r) => !resolved(r));

  const save = () =>
    importComputation.mutate(
      {
        documentId: preview.documentId,
        rows: usable.map((r) => ({ materialId: choices[r.line]?.materialId ?? null, name: r.name, unitCode: r.unitCode!, expected: r.expected, stage: r.stage, wastePct: r.wastePct })),
      },
      {
        onSuccess: () => {
          toast(`Cómputo guardado: ${usable.length} ${usable.length === 1 ? "material" : "materiales"}`);
          onClose();
        },
        onError: (error) => toast(errorMessage(error, "No se pudo guardar el cómputo."), "info"),
      },
    );

  return (
    <Sheet
      open
      onClose={onClose}
      title="Revisar cómputo"
      subtitle={`${preview.fileName} · ${rows.length} filas`}
      size="lg"
      footer={
        <Button icon={Check} size="lg" className="flex-1 lg:flex-none" loading={importComputation.isPending} disabled={!usable.length || pending.length > 0} onClick={save}>
          {pending.length ? `Resuelve ${pending.length} ${pending.length === 1 ? "material" : "materiales"}` : "Guardar cómputo"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        <div className="overflow-hidden rounded-[10px] border border-border">
          <div className="flex gap-3 bg-sunken px-3.5 py-2 text-xs font-medium text-fg-3">
            <span className="flex-1">Material</span>
            <span className="w-24 text-right">Previsto</span>
            <span className="hidden w-24 text-right sm:block">Pedido hoy</span>
          </div>
          {rows.map((r) => {
            const choice = choices[r.line];
            return (
              <div key={r.line} className="flex flex-col gap-2 border-t border-border px-3.5 py-2.5">
                <div className="flex items-center gap-3 text-sm">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-fg">{r.name}</span>
                    <span className={cn("text-xs", r.problem ? "text-danger" : r.match === "suggested" ? "text-warning" : "text-fg-3")}>
                      {r.problem
                        ? `${r.problem} · no se importa`
                        : r.match === "matched"
                          ? r.materialName === r.name
                            ? "En el catálogo"
                            : `Vinculado a ${r.materialName}`
                          : r.match === "new"
                            ? "Material nuevo: se agregará al catálogo"
                            : "¿Cuál es? Elige una opción"}
                    </span>
                  </span>
                  <span className="w-24 text-right font-mono text-fg">
                    {formatNumber(r.expected)} <span className="font-sans text-xs text-fg-3">{r.unit}</span>
                  </span>
                  <span className="hidden w-24 text-right font-mono text-fg-2 sm:block">{r.ordered === null ? "—" : formatNumber(r.ordered)}</span>
                </div>
                {r.match === "suggested" && !r.problem ? (
                  <div className="flex flex-wrap gap-2">
                    {r.candidates.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setChoices({ ...choices, [r.line]: { materialId: c.id, confirmed: true } })}
                        className={cn("inline-flex h-8 items-center rounded-2xl border px-3 text-[13px]", choice?.confirmed && choice.materialId === c.id ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-2")}
                      >
                        {c.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setChoices({ ...choices, [r.line]: { materialId: null, confirmed: true } })}
                      className={cn("inline-flex h-8 items-center rounded-2xl border border-dashed px-3 text-[13px]", choice?.confirmed && choice.materialId === null ? "border-accent text-accent" : "border-border-strong text-fg-2")}
                    >
                      Material nuevo
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="flex items-start gap-2 text-[13px] text-fg-3">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          Los pedidos ya registrados se comparan automáticamente con estas cantidades. Si un material ya tenía cómputo, el valor anterior queda en el historial.
        </p>
      </div>
    </Sheet>
  );
}

