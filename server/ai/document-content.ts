import { AIError } from "./errors";

// Document → text boundary. Interpretation consumes normalized content and
// never knows whether the bytes came from R2, the local disk or a fixture.
// Extractors receive a byte source instead of a storage implementation.

/** Metadata of a stored document (the `documents` row, minus storage details). */
export interface DocumentRecord {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface ExtractedDocumentContent {
  /** Markdown when the extractor preserves structure (tables), plain text otherwise. */
  format: "markdown" | "text";
  /** Empty when the document has no readable text (e.g. a photo without OCR). */
  text: string;
  /** Which extractor produced it, stored for traceability. */
  extractor: string;
  pageCount?: number;
}

export interface DocumentContentExtractor {
  readonly id: string;
  extract(document: DocumentRecord): Promise<ExtractedDocumentContent>;
}

export type DocumentBytesSource = (document: DocumentRecord) => Promise<Uint8Array>;

/** Formats a content extractor may be asked to read. Spreadsheets go through the computation import instead. */
export const INTERPRETABLE_DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Text of simple, uncompressed PDFs (`(text) Tj` operators). Scans and compressed PDFs need a real extractor. */
export function extractPdfText(data: Uint8Array): string {
  const raw = new TextDecoder("latin1").decode(data);
  const lines: string[] = [];
  for (const block of raw.matchAll(/BT([\s\S]*?)ET/g)) {
    const parts = [...block[1]!.matchAll(/\((.*?)(?<!\\)\)\s*Tj/g)].map((m) => m[1]!.replace(/\\([()\\])/g, "$1"));
    if (parts.length) lines.push(parts.join(""));
  }
  return lines.join("\n");
}

/**
 * Local, dependency-free extractor: reads text from simple PDFs (the seed and
 * `samples/` documents). Images yield empty text, which the assistant reports
 * as unreadable. Used for local development and tests.
 */
export class LocalDocumentContentExtractor implements DocumentContentExtractor {
  readonly id = "local";
  constructor(private bytes: DocumentBytesSource) {}

  async extract(document: DocumentRecord): Promise<ExtractedDocumentContent> {
    if (!INTERPRETABLE_DOCUMENT_TYPES.has(document.mimeType)) throw new AIError("AI_DOCUMENT_UNSUPPORTED");
    if (document.mimeType !== "application/pdf") return { format: "text", text: "", extractor: this.id };
    const data = await this.bytes(document);
    return { format: "text", text: extractPdfText(data), extractor: this.id };
  }
}

/**
 * Returns prepared text per document (matched by id, sha256 or file name),
 * falling back to another extractor. For tests and demos of document flows
 * without OCR.
 */
export class FixtureDocumentContentExtractor implements DocumentContentExtractor {
  readonly id = "fixture";
  constructor(
    private fixtures: Record<string, string>,
    private fallback?: DocumentContentExtractor,
  ) {}

  async extract(document: DocumentRecord): Promise<ExtractedDocumentContent> {
    const text = this.fixtures[document.id] ?? (document.sha256 ? this.fixtures[document.sha256] : undefined) ?? this.fixtures[document.fileName];
    if (text !== undefined) return { format: "markdown", text, extractor: this.id };
    if (this.fallback) return this.fallback.extract(document);
    throw new AIError("AI_DOCUMENT_UNSUPPORTED");
  }
}

/** Used when document reading is not available (AI disabled). */
export class DisabledDocumentContentExtractor implements DocumentContentExtractor {
  readonly id = "disabled";
  async extract(): Promise<never> {
    throw new AIError("AI_NOT_CONFIGURED");
  }
}
