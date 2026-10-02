import type { AIAnswer, Extraction } from "./schemas";

// Provider-independent AI boundary. Domain code depends only on this
// interface; Anthropic, a deterministic mock, or Cloudflare Workers AI can
// implement it.

/** Compact, verified project facts given to the provider so it can recognize names. */
export interface AIContext {
  today: string;
  suppliers: string[];
  materials: { name: string; unit: string; aliases: string[] }[];
  openOrders: { reference: string; supplier: string; items: string }[];
}

export interface AIInput {
  text: string;
  context: AIContext;
}

export interface DocumentInput {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
  /** What the user wrote next to the attachment, if anything. */
  text?: string;
  context: AIContext;
}

export interface AIQuestionContext {
  question: string;
  today: string;
  /** Verified figures computed by the application; the provider must not invent others. */
  facts: string;
}

export interface AIProvider {
  readonly name: string;
  readonly model?: string;
  interpret(input: AIInput): Promise<Extraction>;
  analyzeDocument(input: DocumentInput): Promise<Extraction>;
  answer(input: AIQuestionContext): Promise<AIAnswer>;
}

export class AIUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AIUnavailableError";
  }
}

export class AIMalformedResponseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AIMalformedResponseError";
  }
}
