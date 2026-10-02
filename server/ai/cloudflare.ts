import type { DocumentBytesSource, DocumentContentExtractor, DocumentRecord, ExtractedDocumentContent } from "./document-content";
import { AIError } from "./errors";
import type { AIDocumentInput, AIInterpretationInput, AIProvider, AIQuestionInput } from "./provider";
import type { AIAnswerResult, AIInterpretationResult } from "./schemas";

// ============================================================================
// CLOUDFLARE INTEGRATION POINT — intentionally not implemented yet.
//
// These adapters are the only place that should know about Workers AI. They
// currently throw AI_NOT_CONFIGURED so `AI_PROVIDER=cloudflare` is a valid
// configuration that degrades cleanly until the binding is wired.
//
// To implement (see docs/AI_HANDOFF.md):
//   CloudflareAIProvider.interpret / analyzeDocument / answer
//     1. const p = interpretationPrompt(input)  (or documentPrompt / answerPrompt, ./prompts.ts)
//     2. call the Workers AI binding with p.system + p.user, asking for JSON matching p.jsonSchema
//     3. return parseInterpretationResult(json) / parseAnswerResult(json) with meta { provider: "cloudflare", model }
//     4. map failures: missing binding → AI_NOT_CONFIGURED; quota/neuron limit (429, 4006) → AI_QUOTA_EXCEEDED;
//        network/5xx/timeouts → AI_PROVIDER_UNAVAILABLE; unparsable JSON → AI_INVALID_RESPONSE
//   CloudflareDocumentContentExtractor.extract
//     bytes(document) → env.AI.toMarkdown([{ name, blob }]) → { format: "markdown", text, extractor: "cloudflare" };
//     unsupported formats → AI_DOCUMENT_UNSUPPORTED
//
// Nothing else (intent schemas, matching, proposals, confirmation, queries,
// UI) needs to change.
// ============================================================================

export interface CloudflareAIOptions {
  /** The Workers AI binding (`env.AI`), passed through untouched. Typed loosely on purpose. */
  binding?: unknown;
  /** Text-generation model id for interpretation and answers. */
  model?: string;
}

export class CloudflareAIProvider implements AIProvider {
  readonly id = "cloudflare" as const;
  readonly name = "cloudflare";
  readonly model?: string;
  readonly configured = false;

  constructor(private options: CloudflareAIOptions = {}) {
    this.model = options.model;
  }

  async interpret(input: AIInterpretationInput): Promise<AIInterpretationResult> {
    void input;
    void this.options;
    throw new AIError("AI_NOT_CONFIGURED");
  }

  async analyzeDocument(input: AIDocumentInput): Promise<AIInterpretationResult> {
    void input;
    throw new AIError("AI_NOT_CONFIGURED");
  }

  async answer(input: AIQuestionInput): Promise<AIAnswerResult> {
    void input;
    throw new AIError("AI_NOT_CONFIGURED");
  }
}

export class CloudflareDocumentContentExtractor implements DocumentContentExtractor {
  readonly id = "cloudflare";
  constructor(
    private bytes: DocumentBytesSource,
    private options: CloudflareAIOptions = {},
  ) {}

  async extract(document: DocumentRecord): Promise<ExtractedDocumentContent> {
    void document;
    void this.bytes;
    void this.options;
    throw new AIError("AI_NOT_CONFIGURED");
  }
}
