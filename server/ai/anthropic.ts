import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AIMalformedResponseError, AIUnavailableError, type AIContext, type AIInput, type AIProvider, type AIQuestionContext, type DocumentInput } from "./provider";
import { AnswerSchema, ExtractionSchema, type AIAnswer, type Extraction } from "./schemas";

// Anthropic implementation of the AIProvider boundary. Nothing outside this
// file imports the Anthropic SDK. Uses only fetch-based SDK calls and Web APIs
// (btoa, TextDecoder), so it also runs on Cloudflare Workers.

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /** Effort for message/document extraction (the model's default is "medium"). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  baseURL?: string;
  timeoutMs?: number;
  /** Injected fetch, for tests. */
  fetch?: typeof fetch;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const EXTRACTION_SYSTEM = `Sos el asistente de una obra de construcción residencial en Córdoba, Argentina ("Casa Córdoba").
Tu tarea es EXTRAER datos de un mensaje del propietario o de un comprobante (pedido, remito, comprobante de pago). No inventes datos.

Reglas:
- Devolvé solo lo que está dicho o es inequívoco. Si un dato falta, usá null (o lista vacía / false).
- No calcules saldos ni importes que no estén escritos: la aplicación calcula todo con su base de datos.
- "material": copiá cómo se nombró ("barras del 12", "hierro del 10", "Acero Ø12", "cemento"). No lo normalices.
- "quantity": número; "unit": la palabra de unidad tal como aparece ("barras", "bolsas", "m3", "kg").
- Importes en pesos argentinos como número (500.000 → 500000; "400 mil" → 400000; "1,5 millones" → 1500000).
- Fechas en formato YYYY-MM-DD. "hoy"/"ayer" relativos a la fecha de hoy indicada.
- intent:
  - create_order: alguien pidió/compró material a un proveedor (el pedido ya ocurrió).
  - register_delivery: llegó material (con cantidades).
  - complete_order_delivery: llegó todo lo pendiente / el resto de un pedido (deliverAllPending=true).
  - create_payment: se pagó un importe (a uno o varios pedidos, o sin aclarar a qué).
  - pay_order_balance: "pagamos completo el pedido X" (paysFullOrderBalance=true; no inventes el importe).
  - record_supplier_account_payment: pago a cuenta corriente del proveedor, sin pedido (toCurrentAccount=true).
  - allocate_payment: imputar un pago ya registrado (sin imputar) a un pedido.
  - ask_query: pregunta (completá "query"). unknown: cualquier otra cosa.
- Para documentos: documentType = order_proof (comprobante de pedido/presupuesto/nota de venta), delivery_proof (remito/entrega),
  payment_proof (transferencia/recibo de pago), other, o unreadable si no se puede leer (foto borrosa, cortada).
- "note": una frase breve en español si algo es dudoso o falta. Nunca menciones facturas: este sistema no maneja facturas.`;

function contextText(c: AIContext): string {
  const lines = [
    `Fecha de hoy: ${c.today}`,
    `Proveedores conocidos: ${c.suppliers.join("; ") || "ninguno"}`,
    `Materiales del catálogo: ${c.materials.map((m) => `${m.name} (${m.unit}${m.aliases.length ? `; también: ${m.aliases.slice(0, 4).join(", ")}` : ""})`).join("; ") || "ninguno"}`,
    `Pedidos abiertos: ${c.openOrders.map((o) => `pedido ${o.reference} de ${o.supplier}: ${o.items}`).join(" | ") || "ninguno"}`,
  ];
  return lines.join("\n");
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) binary += String.fromCharCode(...data.subarray(i, i + chunk));
  return btoa(binary);
}

export class AnthropicAIProvider implements AIProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;
  private effort: NonNullable<AnthropicProviderOptions["effort"]>;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model ?? "claude-opus-5-5";
    this.effort = options.effort ?? "low";
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 90_000,
      maxRetries: 2,
      fetch: options.fetch,
    });
  }

  private async parse<T extends z.ZodType>(schema: T, system: string, content: Anthropic.Beta.Messages.BetaContentBlockParam[], effort = this.effort): Promise<z.infer<T>> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system,
        // Re-run a policy decline on Anthropic's recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort, format: betaZodOutputFormat(schema) },
        messages: [{ role: "user", content }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new AIUnavailableError("La clave de la API de IA no es válida o no tiene permisos.", error);
      }
      if (error instanceof Anthropic.RateLimitError) throw new AIUnavailableError("El servicio de IA está saturado. Intenta de nuevo en unos minutos.", error);
      if (error instanceof Anthropic.BadRequestError) throw new AIMalformedResponseError("El servicio de IA rechazó la solicitud.", error);
      if (error instanceof Anthropic.APIError) throw new AIUnavailableError(`El servicio de IA respondió con un error (${error.status ?? "sin estado"}).`, error);
      if (error instanceof Anthropic.APIConnectionError) throw new AIUnavailableError("No hay conexión con el servicio de IA.", error);
      throw new AIMalformedResponseError("La respuesta del servicio de IA no tiene el formato esperado.", error);
    }
    if (response.stop_reason === "refusal") throw new AIUnavailableError("El servicio de IA no procesó este mensaje.");
    if (response.stop_reason === "max_tokens") throw new AIMalformedResponseError("La respuesta del servicio de IA quedó incompleta.");
    // Validate again with the application schema: the provider output is never trusted as-is.
    const checked = schema.safeParse(response.parsed_output);
    if (!checked.success) throw new AIMalformedResponseError("La respuesta del servicio de IA no tiene el formato esperado.", checked.error);
    return checked.data;
  }

  async interpret(input: AIInput): Promise<Extraction> {
    return this.parse(ExtractionSchema, EXTRACTION_SYSTEM, [
      { type: "text", text: `${contextText(input.context)}\n\nMensaje del usuario:\n${input.text}` },
    ]);
  }

  async analyzeDocument(input: DocumentInput): Promise<Extraction> {
    const data = toBase64(input.data);
    let block: Anthropic.Beta.Messages.BetaContentBlockParam;
    if (input.mimeType === "application/pdf") {
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
    } else if (IMAGE_TYPES.has(input.mimeType)) {
      block = { type: "image", source: { type: "base64", media_type: input.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data } };
    } else {
      throw new AIMalformedResponseError(`El formato ${input.mimeType} no se puede analizar.`);
    }
    return this.parse(
      ExtractionSchema,
      EXTRACTION_SYSTEM,
      [
        block,
        {
          type: "text",
          text: `${contextText(input.context)}\n\nArchivo: ${input.fileName}\n${input.text ? `Mensaje que acompaña al archivo: ${input.text}\n` : ""}Identificá el tipo de comprobante y extraé sus datos.`,
        },
      ],
      this.effort === "low" ? "medium" : this.effort,
    );
  }

  async answer(input: AIQuestionContext): Promise<AIAnswer> {
    return this.parse(
      AnswerSchema,
      `Respondés en español rioplatense, breve y claro, preguntas sobre una obra. Usá SOLO los datos verificados que te da la aplicación; si la respuesta no está en esos datos, decí que no lo sabés y sugerí cómo averiguarlo en la app. No inventes cifras. Nunca hables de facturas.`,
      [{ type: "text", text: `Fecha: ${input.today}\nDatos verificados:\n${input.facts}\n\nPregunta: ${input.question}` }],
    );
  }
}
