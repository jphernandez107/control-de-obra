import { AIUnavailableError, type AIProvider } from "./provider";

export const AI_NOT_CONFIGURED_MESSAGE = "La función de IA todavía no está configurada.";

export class AINotConfiguredError extends AIUnavailableError {
  constructor() {
    super(AI_NOT_CONFIGURED_MESSAGE);
    this.name = "AINotConfiguredError";
  }
}

/** Deployments without an AI provider: every call fails with a clear Spanish message, nothing is sent anywhere. */
export class DisabledAIProvider implements AIProvider {
  readonly name = "deshabilitada";
  async interpret(): Promise<never> {
    throw new AINotConfiguredError();
  }
  async analyzeDocument(): Promise<never> {
    throw new AINotConfiguredError();
  }
  async answer(): Promise<never> {
    throw new AINotConfiguredError();
  }
}
