import { Download, FileText, Image as ImageIcon } from "lucide-react";
import type { DocumentRef } from "@/domain/types";
import { formatDate } from "@/domain/format";
import { documentKindLabel } from "../ui/DocChip";
import { Sheet } from "../ui/Sheet";

const PREVIEWABLE_IMAGE = /^image\/(jpeg|png|webp|gif)$/;

/** Shows the stored file: images inline, PDFs in the browser viewer, anything else as a download. */
export function DocumentPreview({ doc, onClose }: { doc: DocumentRef | null; onClose: () => void }) {
  const Icon = doc?.format === "pdf" ? FileText : ImageIcon;
  const url = doc?.url;
  const isImage = Boolean(doc?.mimeType && PREVIEWABLE_IMAGE.test(doc.mimeType));
  const isPdf = doc?.mimeType === "application/pdf";
  return (
    <Sheet
      open={Boolean(doc)}
      onClose={onClose}
      title={doc?.fileName}
      subtitle={doc ? `${documentKindLabel[doc.kind]} · ${formatDate(doc.date)}${doc.orderNumber ? ` · pedido ${doc.orderNumber}` : ""}` : undefined}
      size="lg"
      footer={
        url ? (
          <a
            href={`${url}?download=1`}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] border border-border-strong bg-surface px-4 text-[15px] font-medium text-fg hover:bg-sunken lg:flex-none"
          >
            <Download size={18} />
            Descargar
          </a>
        ) : null
      }
    >
      {doc && url && isImage ? (
        <div className="flex w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-sunken">
          <img src={url} alt={doc.fileName} className="max-h-[70vh] w-auto object-contain" />
        </div>
      ) : doc && url && isPdf ? (
        <object data={url} type="application/pdf" aria-label={doc.fileName} className="h-[70vh] w-full rounded-xl border border-border bg-sunken">
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="flex size-14 items-center justify-center rounded-xl bg-danger-soft text-danger">
              <FileText size={26} />
            </span>
            <span className="text-sm font-medium text-fg">{doc.fileName}</span>
            <a href={url} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-accent">
              Abrir el PDF en otra pestaña
            </a>
          </div>
        </object>
      ) : doc ? (
        <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-sunken text-center">
          <span className={doc.format === "pdf" ? "flex size-14 items-center justify-center rounded-xl bg-danger-soft text-danger" : "flex size-14 items-center justify-center rounded-xl bg-info-soft text-info"}>
            <Icon size={26} />
          </span>
          <span className="text-sm font-medium text-fg">{doc.fileName}</span>
          <span className="max-w-[320px] px-6 text-[13px] text-fg-3">Vista previa no disponible para este formato · {doc.sizeLabel}. Puedes descargar el archivo original.</span>
        </div>
      ) : null}
    </Sheet>
  );
}
