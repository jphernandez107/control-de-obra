import { Fragment, type ReactNode } from "react";
import { Image as ImageIcon, Sparkles, FileText } from "lucide-react";
import type { AssistantBlock, Attachment, ChatMessage, Interpretation } from "@/domain/assistant";
import { formatDate, relativeDayLabel } from "@/domain/format";
import { cn } from "@/components/ui/cn";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { useAssistant } from "./AssistantProvider";
import { DeliveryCard } from "./cards/DeliveryCard";
import { OrderCard } from "./cards/OrderCard";
import { PaymentCard } from "./cards/PaymentCard";
import { ConfirmedCard, ResolvedRow, SavedRecord } from "./cards/ResultCards";
import { ActionChips, AnalysisCard, BalanceBlock, ChoiceBlock, PendingDeliveriesBlock, QuantitiesBlock, ReadErrorCard } from "./cards/AnswerBlocks";

export interface ThreadActions {
  onPrompt: (text: string) => void;
  onRetakePhoto: () => void;
  onManualEntry: () => void;
}

function interpretationLabel(i: Interpretation): string {
  if (i.kind === "order") return `Pedido ${i.number} · ${i.supplierName}`;
  if (i.kind === "delivery") return `Entrega del pedido ${i.orderNumber}`;
  return `Pago de ${i.supplierName}`;
}

const WIDE: AssistantBlock["type"][] = ["interpretation", "analysis", "read_error"];

function AiAvatar({ size = 28 }: { size?: 24 | 28 }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center bg-ai-soft text-ai", size === 28 ? "size-7 rounded-lg" : "size-6 rounded-[7px]")}>
      <Sparkles size={size === 28 ? 15 : 13} />
    </span>
  );
}

function AttachmentPreview({ attachment, large }: { attachment: Attachment; large?: boolean }) {
  const Icon = attachment.format === "pdf" ? FileText : ImageIcon;
  return (
    <div
      className={cn(
        "flex items-end rounded-[10px] bg-border bg-cover bg-center p-2",
        large ? "h-[132px] w-[220px]" : "h-[100px] w-[180px]",
        attachment.format === "pdf" && "bg-danger-soft",
      )}
      style={attachment.previewUrl ? { backgroundImage: `url(${attachment.previewUrl})` } : undefined}
    >
      <span className="flex max-w-full items-center gap-[5px] rounded-md bg-fg/80 px-2 py-1 text-[11px] text-surface">
        <Icon size={12} className="shrink-0" />
        <span className="truncate">{attachment.fileName}</span>
      </span>
    </div>
  );
}

function UserMessage({ message, desktop }: { message: ChatMessage; desktop: boolean }) {
  const hasAttachment = Boolean(message.attachments?.length);
  return (
    <div className="flex w-full justify-end">
      <div className={cn("flex max-w-[85%] flex-col gap-2 rounded-[16px_16px_4px_16px] bg-surface-2 lg:max-w-[420px]", hasAttachment ? "p-2" : "px-3.5 py-2.5")}>
        {message.attachments?.map((a) => (
          <AttachmentPreview key={a.id} attachment={a} large={desktop} />
        ))}
        {message.text ? <p className={cn("text-[15px] leading-[22px] whitespace-pre-wrap text-fg", hasAttachment && "px-1.5 pb-1")}>{message.text}</p> : null}
      </div>
    </div>
  );
}

function BlockView({ block, actions }: { block: AssistantBlock; actions: ThreadActions }) {
  const assistant = useAssistant();
  switch (block.type) {
    case "text":
      return <p className="text-[15px] leading-[23px] text-fg">{block.text}</p>;
    case "note":
      return <p className="text-sm leading-[21px] text-fg-2">{block.text}</p>;
    case "analysis":
      return <AnalysisCard title={block.title} steps={block.steps} />;
    case "interpretation": {
      const isResult = block.id.endsWith("-result");
      if (isResult) {
        if (block.state === "confirmed" && block.result) {
          const recordId = block.result.recordId;
          return <ConfirmedCard result={block.result} interpretation={block.interpretation} onUndo={() => assistant.undo(recordId)} />;
        }
        return <ResolvedRow state="cancelled" label={`${block.interpretation.kind === "order" ? "Pedido" : block.interpretation.kind === "delivery" ? "Entrega" : "Pago"} deshecho`} />;
      }
      if (block.state === "confirmed" || block.state === "cancelled") {
        return <ResolvedRow state={block.state} result={block.result} label={interpretationLabel(block.interpretation)} />;
      }
      const common = {
        confirming: block.state === "confirming",
        onConfirm: () => assistant.confirm(block.id),
        onCancel: () => assistant.cancel(block.id),
      };
      const i = block.interpretation;
      if (i.kind === "order") return <OrderCard interpretation={i} onChange={(n) => assistant.updateInterpretation(block.id, n)} {...common} />;
      if (i.kind === "delivery") return <DeliveryCard interpretation={i} onChange={(n) => assistant.updateInterpretation(block.id, n)} {...common} />;
      return <PaymentCard interpretation={i} onChange={(n) => assistant.updateInterpretation(block.id, n)} {...common} />;
    }
    case "choice":
      return (
        <ChoiceBlock
          options={block.options}
          selected={block.selected}
          warning={block.warning}
          resolved={block.resolved}
          onSelect={(id) => assistant.chooseOption(block.id, id)}
          onContinue={() => assistant.continueChoice(block.id)}
        />
      );
    case "read_error":
      return <ReadErrorCard onRetake={actions.onRetakePhoto} onManual={actions.onManualEntry} onRetry={actions.onRetakePhoto} />;
    case "balance":
      return <BalanceBlock {...block} />;
    case "quantities":
      return <QuantitiesBlock rows={block.rows} computationPrompt={block.computationPrompt} />;
    case "pending_deliveries":
      return <PendingDeliveriesBlock rows={block.rows} />;
    case "saved_record":
      return <SavedRecord title={block.title} subtitle={block.subtitle} tag={block.tag} link={block.link} />;
    case "actions":
      return <ActionChips actions={block.actions} onPrompt={actions.onPrompt} />;
  }
}

function TypingDots() {
  return (
    <span className="flex h-[23px] items-center gap-1" aria-label="El asistente está escribiendo">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 animate-shimmer rounded-full bg-fg-3" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
}

function AssistantMessage({ message, desktop, actions }: { message: ChatMessage; desktop: boolean; actions: ThreadActions }) {
  const blocks = message.blocks ?? [];
  const typing = blocks.length === 0 && message.status;

  if (desktop) {
    return (
      <div className="flex w-full gap-3">
        <AiAvatar />
        <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
          {typing ? <TypingDots /> : null}
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} actions={actions} />
          ))}
        </div>
      </div>
    );
  }

  const segments: { wide: boolean; blocks: AssistantBlock[] }[] = [];
  for (const b of blocks) {
    const wide = WIDE.includes(b.type);
    const last = segments.at(-1);
    if (last && last.wide === wide && !wide) last.blocks.push(b);
    else segments.push({ wide, blocks: [b] });
  }
  const startsWide = segments[0]?.wide ?? true;
  const label = message.status ?? (blocks.some((b) => b.type === "interpretation" && b.state === "pending") ? "Asistente · revisa antes de guardar" : "Asistente");

  return (
    <div className="flex w-full flex-col gap-3">
      {startsWide && (typing || (segments.length > 0 && !(blocks[0]?.type === "interpretation" && blocks[0].id.endsWith("-result")))) ? (
        <div className="flex items-center gap-2">
          <AiAvatar size={24} />
          <span className="text-xs text-fg-3">{typing ? message.status : label}</span>
        </div>
      ) : null}
      {segments.map((s, i) =>
        s.wide ? (
          <Fragment key={i}>
            {s.blocks.map((b, j) => (
              <BlockView key={j} block={b} actions={actions} />
            ))}
          </Fragment>
        ) : (
          <div key={i} className="flex w-full gap-2.5">
            {i === 0 ? <AiAvatar size={24} /> : <span className="w-6 shrink-0" />}
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
              {s.blocks.map((b, j) => (
                <BlockView key={j} block={b} actions={actions} />
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex w-full items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium text-fg-3">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function Thread({ messages, today, actions, footer }: { messages: ChatMessage[]; today: string; actions: ThreadActions; footer?: ReactNode }) {
  const desktop = useIsDesktop();
  let lastDay = "";
  return (
    <div className="flex w-full flex-col gap-3.5 lg:gap-[22px]">
      {messages.map((m) => {
        const day = m.at.slice(0, 10);
        const showDay = desktop && day !== lastDay;
        lastDay = day;
        return (
          <Fragment key={m.id}>
            {showDay ? <DaySeparator label={`${relativeDayLabel(day, today)} · ${formatDate(day)}`} /> : null}
            {m.role === "user" ? <UserMessage message={m} desktop={desktop} /> : <AssistantMessage message={m} desktop={desktop} actions={actions} />}
          </Fragment>
        );
      })}
      {footer}
    </div>
  );
}
