import { Download, FileText, Image as ImageIcon } from "lucide-react";
import type { DocumentRef } from "@/domain/types";
import { formatDate } from "@/domain/format";
import { Button } from "../ui/Button";
import { documentKindLabel } from "../ui/DocChip";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";

/** Preview placeholder until real document storage exists. */
export function DocumentPreview({ doc, onClose }: { doc: DocumentRef | null; onClose: () => void }) {
  const toast = useToast();
  const Icon = doc?.format === "pdf" ? FileText : ImageIcon;
  return (
    <Sheet open={Boolean(doc)} onClose={onClose} title={doc?.fileName} subtitle={doc ? `${documentKindLabel[doc.kind]} · ${formatDate(doc.date)}${doc.orderNumber ? ` · pedido ${doc.orderNumber}` : ""}` : undefined} size="lg"
      footer={
        <Button variant="secondary" icon={Download} className="flex-1 lg:flex-none" onClick={() => toast("La descarga estará disponible cuando los documentos se guarden en el servidor", "info")}>
          Descargar
        </Button>
      }
    >
      {doc ? (
        <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-sunken text-center">
          <span className={doc.format === "pdf" ? "flex size-14 items-center justify-center rounded-xl bg-danger-soft text-danger" : "flex size-14 items-center justify-center rounded-xl bg-info-soft text-info"}>
            <Icon size={26} />
          </span>
          <span className="text-sm font-medium text-fg">{doc.fileName}</span>
          <span className="max-w-[320px] px-6 text-[13px] text-fg-3">Vista previa de ejemplo · {doc.sizeLabel}. El archivo original se mostrará acá cuando el almacenamiento de documentos esté conectado.</span>
        </div>
      ) : null}
    </Sheet>
  );
}
