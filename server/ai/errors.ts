// Application-owned AI failure states. Providers and document extractors map
// their own errors (HTTP status, binding errors, quota responses, malformed
// JSON) into these codes; nothing outside an adapter sees vendor errors.

export const AI_ERROR_CODES = [
  "AI_NOT_CONFIGURED",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_TEMPORARILY_UNAVAILABLE",
  "AI_MODEL_UNAVAILABLE",
  "AI_QUOTA_EXCEEDED",
  "AI_INVALID_RESPONSE",
  "AI_DOCUMENT_UNSUPPORTED",
  "AI_DOCUMENT_CONVERSION_FAILED",
  "AI_INTERPRETATION_AMBIGUOUS",
] as const;

export type AIErrorCode = (typeof AI_ERROR_CODES)[number];

/** Spanish messages shown to the user, as-is. */
export const AI_ERROR_MESSAGES: Record<AIErrorCode, string> = {
  AI_NOT_CONFIGURED: "La función de IA todavía no está configurada.",
  AI_PROVIDER_UNAVAILABLE: "La IA no está disponible en este momento. El resto de la aplicación sigue funcionando.",
  AI_TEMPORARILY_UNAVAILABLE: "La IA está saturada en este momento. El resto de la aplicación sigue funcionando.",
  AI_MODEL_UNAVAILABLE: "El modelo de IA configurado no está disponible. El resto de la aplicación sigue funcionando.",
  AI_QUOTA_EXCEEDED: "La cuota gratuita de IA de hoy se agotó. El resto de la aplicación sigue disponible y la IA volverá a estar disponible cuando se renueve la cuota.",
  AI_INVALID_RESPONSE: "No pude interpretar la respuesta de la IA.",
  AI_DOCUMENT_UNSUPPORTED: "No puedo leer este tipo de documento.",
  AI_DOCUMENT_CONVERSION_FAILED: "No pude leer el contenido del documento.",
  AI_INTERPRETATION_AMBIGUOUS: "No pude interpretar el documento con suficiente seguridad.",
};

/** What the user can do instead, shown under the message. */
export const AI_ERROR_HINTS: Record<AIErrorCode, string> = {
  AI_NOT_CONFIGURED: "Mientras tanto puedes registrar pedidos, entregas y pagos desde Pedidos o Proveedores, y consultar saldos en Proveedores.",
  AI_PROVIDER_UNAVAILABLE: "Puedes intentar de nuevo en un momento, o registrar entregas y pagos desde Pedidos o Proveedores.",
  AI_TEMPORARILY_UNAVAILABLE: "Intenta de nuevo en unos minutos, o registra entregas y pagos desde Pedidos o Proveedores.",
  AI_MODEL_UNAVAILABLE: "Hay que revisar la configuración del modelo (AI_TEXT_MODEL / AI_VISION_MODEL). Mientras tanto puedes registrar entregas y pagos desde Pedidos o Proveedores.",
  AI_QUOTA_EXCEEDED: "La cuota se renueva todos los días a las 21:00 (hora de Córdoba). Mientras tanto puedes registrar entregas y pagos desde Pedidos o Proveedores.",
  AI_INVALID_RESPONSE: "Intenta reformular el mensaje o vuelve a enviarlo.",
  AI_DOCUMENT_UNSUPPORTED: "Envía el comprobante como PDF, JPG o PNG, o carga los datos a mano.",
  AI_DOCUMENT_CONVERSION_FAILED: "Prueba con otra foto o con el PDF original, o carga los datos a mano.",
  AI_INTERPRETATION_AMBIGUOUS: "Cuéntame qué es el documento (pedido, remito o comprobante de pago) o carga los datos a mano.",
};

export class AIError extends Error {
  readonly code: AIErrorCode;
  constructor(code: AIErrorCode, message?: string, readonly cause?: unknown) {
    super(message ?? AI_ERROR_MESSAGES[code]);
    this.name = "AIError";
    this.code = code;
  }
}

export function isAIError(error: unknown): error is AIError {
  return error instanceof AIError;
}

/** Normalizes anything a provider threw: schema failures are invalid responses, the rest means the provider is unavailable. */
export function toAIError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  if (error instanceof Error && error.name === "ZodError") return new AIError("AI_INVALID_RESPONSE", undefined, error);
  return new AIError("AI_PROVIDER_UNAVAILABLE", undefined, error);
}
