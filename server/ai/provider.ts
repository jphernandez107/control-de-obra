import type { ExtractedDocumentContent } from "./document-content";
import type { ProjectQueryResult } from "./project-queries";
import type { AIAnswerResult, AIInterpretationResult } from "./schemas";

// Provider-independent AI boundary. Domain, proposal and UI code depend only
// on these application-owned types; a provider adapter (the deterministic
// mock today, Cloudflare Workers AI later) translates them to and from its
// own API and maps its failures to `AIError` codes (see ./errors.ts).

export type AIProviderId = "mock" | "cloudflare" | "disabled";

/** Compact, verified project facts so the provider can recognize names. Never balances. */
export interface AIProjectContext {
  today: string;
  suppliers: string[];
  materials: { name: string; unit: string; aliases: string[] }[];
  openOrders: { reference: string; supplier: string; items: string }[];
}

/**
 * Short, relevant slice of the conversation (see ./conversation-context.ts).
 * `focus` names what the last exchange was about, so "¿y cuánto falta pagar?"
 * can be understood; figures always come from the database, not from here.
 */
export interface AIConversationContext {
  recent: { role: "user" | "assistant"; text: string }[];
  focus: {
    order?: { reference: string; supplier: string };
    supplier?: string;
    material?: string;
  };
}

export interface AIInterpretationInput {
  text: string;
  project: AIProjectContext;
  conversation: AIConversationContext;
}

export interface AIDocumentInput {
  document: { id: string; fileName: string; mimeType: string };
  /** Normalized content from a DocumentContentExtractor; providers never see storage. */
  content: ExtractedDocumentContent;
  /** What the user wrote next to the attachment, if anything. */
  userText?: string;
  project: AIProjectContext;
  conversation: AIConversationContext;
}

export interface AIQuestionInput {
  question: string;
  today: string;
  /** Results of read-only project queries. The answer must use only these figures. */
  results: ProjectQueryResult[];
  conversation: AIConversationContext;
}

export interface AIProvider {
  readonly id: AIProviderId;
  /** Human label stored with each pending action. */
  readonly name: string;
  readonly model?: string;
  /** Whether the provider can serve requests (false → the UI explains that AI is not configured). */
  readonly configured: boolean;
  interpret(input: AIInterpretationInput): Promise<AIInterpretationResult>;
  analyzeDocument(input: AIDocumentInput): Promise<AIInterpretationResult>;
  answer(input: AIQuestionInput): Promise<AIAnswerResult>;
}
