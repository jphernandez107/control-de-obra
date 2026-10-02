import { MessageSquarePlus, MessagesSquare } from "lucide-react";
import { formatShortDate } from "@/domain/format";
import { Drawer } from "@/components/ui/Sheet";
import { EmptyState, Skeleton } from "@/components/ui/States";
import { useConversations } from "@/queries";
import { useAssistant } from "./AssistantProvider";

export function ConversationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isPending } = useConversations(open);
  const assistant = useAssistant();
  return (
    <Drawer open={open} onClose={onClose} title="Conversaciones">
      <div className="px-3 pt-2">
        <button
          type="button"
          onClick={() => {
            void assistant.startConversation();
            onClose();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-sm font-medium text-accent hover:bg-sunken"
        >
          <MessageSquarePlus size={16} />
          Nueva conversación
        </button>
      </div>
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
          {data.map((c) => {
            const current = c.id === assistant.conversationId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!current) void assistant.openConversation(c.id);
                    onClose();
                  }}
                  className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-sunken"
                  aria-current={current ? "true" : undefined}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">{c.title}</span>
                    <span className="truncate text-[13px] text-fg-3">{c.preview}</span>
                  </span>
                  <span className="font-mono text-xs text-fg-3">{current ? "Actual" : formatShortDate(c.date)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
