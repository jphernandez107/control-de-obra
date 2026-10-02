import { AnthropicAIProvider } from "./anthropic";
import { MockAIProvider } from "./mock";
import type { AIProvider } from "./provider";

export interface ProviderConfig {
  aiProvider: "auto" | "mock" | "anthropic";
  anthropicApiKey?: string;
  aiModel: string;
  aiEffort: "low" | "medium" | "high" | "xhigh" | "max";
}

/** `auto` uses Anthropic when an API key is configured and the deterministic mock otherwise. */
export function createProvider(config: ProviderConfig): AIProvider {
  if (config.aiProvider === "mock") return new MockAIProvider();
  if (config.aiProvider === "anthropic" || config.anthropicApiKey) {
    if (!config.anthropicApiKey) throw new Error("AI_PROVIDER=anthropic requiere ANTHROPIC_API_KEY");
    return new AnthropicAIProvider({ apiKey: config.anthropicApiKey, model: config.aiModel, effort: config.aiEffort });
  }
  return new MockAIProvider();
}
