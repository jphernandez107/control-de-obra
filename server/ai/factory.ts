import { CloudflareAIProvider, CloudflareDocumentContentExtractor } from "./cloudflare";
import { DisabledAIProvider } from "./disabled";
import { DisabledDocumentContentExtractor, LocalDocumentContentExtractor, type DocumentBytesSource, type DocumentContentExtractor } from "./document-content";
import { MockAIProvider } from "./mock";
import type { AIProvider, AIProviderId } from "./provider";

// The single configuration boundary for AI. Entry points (Node server,
// Worker, tests) build an `AIConfig` from their environment and get back the
// provider and the document extractor; nothing else switches on providers.

export interface AIConfig {
  provider: AIProviderId;
  /** Optional model id for providers that use one (AI_MODEL). */
  model?: string;
  /** Cloudflare Workers AI binding (`env.AI`), when running on Workers. */
  cloudflareBinding?: unknown;
}

const IDS: AIProviderId[] = ["mock", "cloudflare", "disabled"];

/** Reads AI_PROVIDER; unknown values fall back (and old values such as "auto" mean the fallback). */
export function parseAIProviderId(value: string | undefined, fallback: AIProviderId): AIProviderId {
  const v = (value ?? "").trim().toLowerCase() as AIProviderId;
  return IDS.includes(v) ? v : fallback;
}

export function getAIProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case "mock":
      return new MockAIProvider();
    case "cloudflare":
      return new CloudflareAIProvider({ binding: config.cloudflareBinding, model: config.model });
    case "disabled":
      return new DisabledAIProvider();
  }
}

export function getDocumentContentExtractor(config: AIConfig, bytes: DocumentBytesSource): DocumentContentExtractor {
  switch (config.provider) {
    case "mock":
      return new LocalDocumentContentExtractor(bytes);
    case "cloudflare":
      return new CloudflareDocumentContentExtractor(bytes, { binding: config.cloudflareBinding });
    case "disabled":
      return new DisabledDocumentContentExtractor();
  }
}
