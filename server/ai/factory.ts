import { AnthropicAIProvider } from "./anthropic";
import { DisabledAIProvider } from "./disabled";
import { MockAIProvider } from "./mock";
import type { AIProvider } from "./provider";

export type AIProviderSetting = "auto" | "mock" | "anthropic" | "disabled";

export interface ProviderConfig {
  aiProvider: AIProviderSetting;
  anthropicApiKey?: string;
  aiModel: string;
  aiEffort: "low" | "medium" | "high" | "xhigh" | "max";
}

export function parseProviderSetting(value: string | undefined, fallback: AIProviderSetting): AIProviderSetting {
  const v = (value ?? "").toLowerCase();
  return v === "auto" || v === "mock" || v === "anthropic" || v === "disabled" ? v : fallback;
}

/** `auto` uses Anthropic when an API key is configured and the deterministic mock otherwise. */
export function createProvider(config: ProviderConfig): AIProvider {
  if (config.aiProvider === "disabled") return new DisabledAIProvider();
  if (config.aiProvider === "mock") return new MockAIProvider();
  if (config.aiProvider === "anthropic" || config.anthropicApiKey) {
    if (!config.anthropicApiKey) throw new Error("AI_PROVIDER=anthropic requiere ANTHROPIC_API_KEY");
    return new AnthropicAIProvider({ apiKey: config.anthropicApiKey, model: config.aiModel, effort: config.aiEffort });
  }
  return new MockAIProvider();
}
