import { AIError } from "./errors";
import type { AIProvider } from "./provider";

/** Deployments without an AI provider: every call fails with AI_NOT_CONFIGURED, nothing is sent anywhere. */
export class DisabledAIProvider implements AIProvider {
  readonly id = "disabled" as const;
  readonly name = "deshabilitada";
  readonly configured = false;
  async interpret(): Promise<never> {
    throw new AIError("AI_NOT_CONFIGURED");
  }
  async analyzeDocument(): Promise<never> {
    throw new AIError("AI_NOT_CONFIGURED");
  }
  async answer(): Promise<never> {
    throw new AIError("AI_NOT_CONFIGURED");
  }
}
