import type { BatchItem } from "drizzle-orm/batch";
import type { AppDb } from "../db/client";
import { auditLog } from "../db/schema";
import { DomainError } from "../domain/errors";
import type { ActivityChange, StatusTag } from "../../src/domain/types";

export interface Actor {
  userId: string;
  name: string;
  role: string;
}

/** Who/what triggers a mutation. `source` and `aiInterpretationId` end up in the audit log. */
export interface CommandContext {
  db: AppDb;
  projectId: string;
  actor: Actor;
  source: "assistant" | "manual" | "seed" | "system";
  aiInterpretationId?: string;
  now: () => Date;
}

export function newId(): string {
  return crypto.randomUUID();
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  shortSummary?: string;
  changes?: ActivityChange[];
  reason?: string;
  tags?: StatusTag[];
  metadata?: Record<string, unknown>;
  supplierId?: string | null;
  orderId?: string | null;
}

/**
 * Statements of one domain command. `commit()` sends them as a single atomic
 * batch (a transaction on libsql and on D1), audit rows included, so either
 * the whole change and its audit trail are stored or nothing is.
 */
export class WriteSet {
  private items: BatchItem<"sqlite">[] = [];
  private auditSeq = 0;
  readonly startedAt: Date;
  constructor(private ctx: CommandContext) {
    this.startedAt = ctx.now();
  }

  get stamp(): string {
    return this.startedAt.toISOString();
  }

  add(statement: BatchItem<"sqlite">) {
    this.items.push(statement);
  }

  audit(entry: AuditEntry) {
    // Entries of one command get increasing timestamps so the feed keeps their order.
    const at = new Date(this.startedAt.getTime() + this.auditSeq++).toISOString();
    const metadata = { ...(entry.metadata ?? {}), ...(entry.tags ? { tags: entry.tags } : {}) };
    this.items.push(
      this.ctx.db.insert(auditLog).values({
        id: newId(),
        projectId: this.ctx.projectId,
        at,
        actorUserId: this.ctx.actor.userId,
        source: this.ctx.source,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        shortSummary: entry.shortSummary ?? null,
        changes: entry.changes?.length ? JSON.stringify(entry.changes) : null,
        reason: entry.reason ?? null,
        metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
        supplierId: entry.supplierId ?? null,
        orderId: entry.orderId ?? null,
        aiInterpretationId: this.ctx.aiInterpretationId ?? null,
      }),
    );
  }

  async commit(): Promise<void> {
    if (!this.items.length) return;
    try {
      await this.ctx.db.batch(this.items as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint/i.test(message)) throw new DomainError("duplicate", "Ya existe un registro con esos datos. Revisa el número o el nombre.");
      if (/FOREIGN KEY|CHECK constraint/i.test(message)) throw new DomainError("validation", "Los datos no cumplen las reglas del sistema (relación o valor inválido). No se guardó nada.");
      throw new DomainError("persistence", "No se pudo guardar en la base de datos. No se guardó nada; intenta de nuevo.", message);
    }
  }
}
