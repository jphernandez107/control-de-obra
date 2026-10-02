import { FileText, Image as ImageIcon, Truck, ReceiptText, ClipboardList } from "lucide-react";
import type { DocumentKind } from "@/domain/types";
import { cn } from "./cn";

export function DocChip({
  fileName,
  meta,
  format,
  onClick,
  className,
  wide,
}: {
  fileName: string;
  meta: string;
  format: "pdf" | "image";
  onClick?: () => void;
  className?: string;
  wide?: boolean;
}) {
  const isPdf = format === "pdf";
  const Icon = isPdf ? FileText : ImageIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-[52px] min-w-0 items-center gap-2.5 rounded-[10px] border border-border bg-surface pr-3.5 pl-2.5 text-left transition-colors hover:bg-sunken",
        wide && "w-full",
        className,
      )}
    >
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", isPdf ? "bg-danger-soft text-danger" : "bg-info-soft text-info")}>
        <Icon size={16} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-fg">{fileName}</span>
        <span className="truncate text-xs text-fg-3">{meta}</span>
      </span>
    </button>
  );
}

export const documentKindLabel: Record<DocumentKind, string> = {
  comprobante_pedido: "Comprobante de pedido",
  remito: "Remito",
  comprobante_pago: "Comprobante de pago",
  computo: "Cómputo",
  otro: "Documento",
};

/** Neutral icon tile used by the supplier document list. */
export function DocKindIcon({ kind, className }: { kind: DocumentKind; className?: string }) {
  const Icon = kind === "remito" ? Truck : kind === "comprobante_pago" ? ReceiptText : kind === "computo" ? ClipboardList : FileText;
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-2", className)}>
      <Icon size={16} />
    </span>
  );
}
