import { MessagesSquare } from "lucide-react";
import { formatShortDate } from "@/domain/format";
import { Drawer } from "@/components/ui/Sheet";
import { EmptyState, Skeleton } from "@/components/ui/States";
import { useConversations } from "@/queries";

export function ConversationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isPending } = useConversations(open);
  return (
    <Drawer open={open} onClose={onClose} title="Conversaciones">
      {isPending ? (
        <div className="flex flex-col gap-3 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !data?.length ? (
        <EmptyState icon={MessagesSquare} title="Todavía no hay conversaciones" description="Lo que registres con el asistente quedará agrupado acá." />
      ) : (
        <ul className="flex flex-col py-2">
          {data.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={onClose}
                className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-sunken"
                aria-current={i === 0 ? "true" : undefined}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-fg">{c.title}</span>
                  <span className="truncate text-[13px] text-fg-3">{c.preview}</span>
                </span>
                <span className="font-mono text-xs text-fg-3">{i === 0 ? "Actual" : formatShortDate(c.date)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
