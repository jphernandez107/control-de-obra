import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { newId } from "../services/context";
import type { DocumentContentExtractor, DocumentRecord, ExtractedDocumentContent } from "./document-content";

/** Reuses a stored reading of the same bytes instead of spending AI quota on it again. Failures are not cached. */
export class CachedDocumentContentExtractor implements DocumentContentExtractor {
  readonly id: string;
  constructor(
    private db: AppDb,
    private projectId: string,
    private inner: DocumentContentExtractor,
    private now: () => Date = () => new Date(),
  ) {
    this.id = inner.id;
  }

  async extract(document: DocumentRecord): Promise<ExtractedDocumentContent> {
    if (!document.sha256) return this.inner.extract(document);
    const [hit] = await this.db
      .select()
      .from(t.documentExtractions)
      .where(and(eq(t.documentExtractions.projectId, this.projectId), eq(t.documentExtractions.sha256, document.sha256)));
    if (hit) return { format: hit.format === "text" ? "text" : "markdown", text: hit.text, extractor: hit.extractor };
    const content = await this.inner.extract(document);
    await this.db
      .insert(t.documentExtractions)
      .values({ id: newId(), projectId: this.projectId, documentId: document.id, sha256: document.sha256, extractor: content.extractor, format: content.format, text: content.text, createdAt: this.now().toISOString() })
      .onConflictDoNothing();
    return content;
  }
}
