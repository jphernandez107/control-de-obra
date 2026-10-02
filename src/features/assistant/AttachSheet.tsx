import type { LucideIcon } from "lucide-react";
import { Camera, ClipboardPaste, FileUp, Images } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/components/ui/cn";

export function AttachSheet({
  open,
  onClose,
  onCamera,
  onGallery,
  onFile,
  onPaste,
}: {
  open: boolean;
  onClose: () => void;
  onCamera: () => void;
  onGallery: () => void;
  onFile: () => void;
  onPaste: () => void;
}) {
  const options: { title: string; sub: string; icon: LucideIcon; action: () => void; primary?: boolean }[] = [
    { title: "Tomar foto", sub: "Ideal para remitos en la obra", icon: Camera, action: onCamera, primary: true },
    { title: "Elegir de la galería", sub: "Fotos o capturas de pantalla", icon: Images, action: onGallery },
    { title: "Subir PDF o archivo", sub: "PDF, JPG o PNG hasta 20 MB", icon: FileUp, action: onFile },
    { title: "Pegar mensaje de WhatsApp", sub: "Texto copiado del chat", icon: ClipboardPaste, action: onPaste },
  ];
  return (
    <Sheet open={open} onClose={onClose} showClose={false}>
      <div className="flex flex-col gap-1.5 pb-6 lg:pt-5">
        <h2 className="text-[17px] font-semibold text-fg">Agregar comprobante</h2>
        <p className="text-[13px] leading-[18px] text-fg-3">Pedido, remito, pago o captura de transferencia. Detecto el tipo automáticamente.</p>
        <div className="h-1.5" />
        {options.map((o) => (
          <button
            key={o.title}
            type="button"
            onClick={() => {
              onClose();
              o.action();
            }}
            className={cn("flex h-[60px] items-center gap-3.5 rounded-xl px-2 text-left transition-colors", o.primary ? "bg-accent-soft" : "hover:bg-sunken")}
          >
            <span className={cn("flex size-10 items-center justify-center rounded-[10px]", o.primary ? "bg-accent text-on-accent" : "bg-surface-2 text-fg-2")}>
              <o.icon size={20} />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-medium text-fg">{o.title}</span>
              <span className="text-[13px] text-fg-3">{o.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
