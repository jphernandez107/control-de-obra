import { z } from "zod";
import { INTERPRETABLE_DOCUMENT_TYPES, type DocumentBytesSource, type DocumentContentExtractor, type DocumentRecord, type ExtractedDocumentContent } from "./document-content";
import { AIError } from "./errors";
import { documentPrompt, interpretationPrompt, answerPrompt, DOCUMENT_TOOL_NOTE, IMAGE_TRANSCRIPTION_PROMPT, INTENT_TOOL_NAMES, PROMPT_VERSION, TOOL_ANSWER_SYSTEM_PROMPT, TOOL_INTERPRETATION_SYSTEM_PROMPT } from "./prompts";
import type { AIDocumentInput, AIInterpretationInput, AIProvider, AIQuestionInput } from "./provider";
import {
  AllocatePaymentSchema,
  ClarificationSchema,
  CompleteOrderDeliverySchema,
  CreateOrderSchema,
  CreateSupplierPaymentSchema,
  DOCUMENT_TYPES,
  parseAnswerResult,
  parseInterpretationResult,
  PayOrderBalanceSchema,
  ProjectQuestionSchema,
  RegisterDeliverySchema,
  UnknownIntentSchema,
  type AIAnswerResult,
  type AIInterpretationResult,
  type IntentName,
} from "./schemas";

// Cloudflare Workers AI adapter: the only code that knows about the `env.AI`
// binding, its request/response shapes and its error codes. Interpretation
// uses tool calling (one tool per intent); a tool call is only a proposal and
// goes through the same schema validation as any other provider output.
// Exactly one model call per request: no retries, no loops.

/** The subset of the Workers AI binding this adapter uses. */
export interface WorkersAIBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  toMarkdown(
    files: { name: string; blob: Blob }[],
    options?: { conversionOptions?: Record<string, unknown> },
  ): Promise<{ name?: string; format?: string; data?: string; error?: string }[]>;
}

export interface CloudflareAIOptions {
  /** The Workers AI binding (`env.AI`). */
  binding?: unknown;
  /** Text-generation model for interpretation and answers (AI_TEXT_MODEL). */
  model?: string;
  /** Vision model that transcribes photos of receipts (AI_VISION_MODEL). Without it, images go through toMarkdown. */
  visionModel?: string;
  /** Largest document sent to Workers AI. */
  maxDocumentBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
/** Longest extracted text kept for interpretation (and cached). */
export const MAX_EXTRACTED_CHARS = 12_000;

function asBinding(binding: unknown): WorkersAIBinding | null {
  return binding && typeof (binding as WorkersAIBinding).run === "function" ? (binding as WorkersAIBinding) : null;
}

/** Maps anything the binding throws to an application AI error. Codes: developers.cloudflare.com/workers-ai/platform/errors/ */
export function mapWorkersAIError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/\b(3036|4006)\b|daily free allocation|neurons/i.test(text)) return new AIError("AI_QUOTA_EXCEEDED", undefined, error);
  if (/\b(5007|3042|5035|5018|3041|5016)\b|no such model|model name is invalid|requires a workers paid/i.test(text)) return new AIError("AI_MODEL_UNAVAILABLE", undefined, error);
  if (/\b3006\b|request is too large/i.test(text)) return new AIError("AI_DOCUMENT_CONVERSION_FAILED", "El documento es demasiado grande para leerlo con IA.", error);
  if (/\b(3040|3007|3008|429)\b|capacity temporarily exceeded|timeout|timed out|aborted/i.test(text)) return new AIError("AI_TEMPORARILY_UNAVAILABLE", undefined, error);
  return new AIError("AI_PROVIDER_UNAVAILABLE", undefined, error);
}

async function callWorkersAI(binding: WorkersAIBinding, model: string, inputs: Record<string, unknown>, op: string, timeoutMs: number): Promise<unknown> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Workers AI timeout")), timeoutMs);
    });
    const raw = await Promise.race([binding.run(model, inputs), timeout]);
    const usage = (raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
    console.log(JSON.stringify({ ai: "workers-ai", op, model, promptVersion: PROMPT_VERSION, ms: Date.now() - started, in: usage?.prompt_tokens, out: usage?.completion_tokens }));
    return raw;
  } catch (error) {
    const mapped = mapWorkersAIError(error);
    console.warn(JSON.stringify({ ai: "workers-ai", op, model, ms: Date.now() - started, error: mapped.code, detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }));
    throw mapped;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return undefined;
  }
}

/** Text content of a chat completion, in either the OpenAI-compatible or the legacy Workers AI shape. */
export function completionText(raw: unknown): string {
  const r = raw as { choices?: { message?: { content?: unknown } }[]; response?: unknown };
  const content = r?.choices?.[0]?.message?.content ?? r?.response;
  return typeof content === "string" ? content : "";
}

/** First tool call of a chat completion, in either response shape. */
export function firstToolCall(raw: unknown): { name: string; args: unknown } | null {
  type Call = { name?: string; arguments?: unknown; parameters?: unknown; function?: Call };
  const r = raw as { choices?: { message?: { tool_calls?: Call[] } }[]; tool_calls?: Call[] };
  const listed = r?.choices?.[0]?.message?.tool_calls?.[0] ?? r?.tool_calls?.[0];
  let call: Call | undefined = listed?.function ?? listed;
  if (!call?.name) {
    // Some models write the call as JSON text instead of a structured tool call.
    const fromText = parseJson(completionText(raw)) as Call | undefined;
    call = fromText?.name ? fromText : undefined;
  }
  if (!call?.name) return null;
  const args = call.arguments ?? call.parameters;
  return { name: call.name, args: typeof args === "string" ? parseJson(args) : args };
}

const INTENT_SCHEMAS = {
  create_order: CreateOrderSchema,
  register_delivery: RegisterDeliverySchema,
  complete_order_delivery: CompleteOrderDeliverySchema,
  create_supplier_payment: CreateSupplierPaymentSchema,
  pay_order_balance: PayOrderBalanceSchema,
  allocate_payment: AllocatePaymentSchema,
  ask_project_question: ProjectQuestionSchema,
  clarification_required: ClarificationSchema,
  unknown: UnknownIntentSchema,
} as const satisfies Record<IntentName, z.ZodObject>;

const TOOL_DESCRIPTIONS: Record<IntentName, string> = {
  create_order: "Proponer el registro de un pedido de materiales que ya se hizo a un proveedor.",
  register_delivery: "Proponer el registro de una entrega (remito) con las cantidades que llegaron.",
  complete_order_delivery: "Proponer que llegó todo lo pendiente de un pedido. La aplicación calcula las cantidades.",
  create_supplier_payment: "Proponer el registro de un pago a un proveedor (a cuenta corriente o a pedidos).",
  pay_order_balance: "Proponer el pago del saldo completo de un pedido. La aplicación calcula el importe.",
  allocate_payment: "Proponer imputar a un pedido un pago ya registrado sin imputar.",
  ask_project_question: "Consultar datos de la obra (saldos, pedidos, entregas, materiales, cómputo). Solo lectura.",
  clarification_required: "Pedir al usuario el dato indispensable que falta o aclarar una ambigüedad.",
  unknown: "El mensaje o documento no es una operación ni una consulta de la obra.",
};

const TOOL_TO_INTENT = Object.fromEntries(Object.entries(INTENT_TOOL_NAMES).map(([intent, tool]) => [tool, intent as IntentName])) as Record<string, IntentName>;

function toolParameters(schema: z.ZodObject, forDocument: boolean): Record<string, unknown> {
  const json = z.toJSONSchema(schema.omit({ intent: true })) as { $schema?: string; properties: Record<string, unknown>; required?: string[] };
  delete json.$schema;
  if (forDocument) {
    json.properties.document_type = { type: "string", enum: [...DOCUMENT_TYPES], description: "Tipo de comprobante." };
    json.properties.document_confidence = { type: "number", minimum: 0, maximum: 1 };
    json.required = [...(json.required ?? []), "document_type", "document_confidence"];
  }
  return json;
}

function intentTools(forDocument: boolean) {
  return (Object.keys(INTENT_SCHEMAS) as IntentName[]).map((intent) => ({
    type: "function",
    function: { name: INTENT_TOOL_NAMES[intent], description: TOOL_DESCRIPTIONS[intent], parameters: toolParameters(INTENT_SCHEMAS[intent], forDocument) },
  }));
}

/**
 * Models often omit arguments they have no value for. Missing keys become the
 * contract's own "nothing said" value (null, [] or false) so the schema can
 * still reject anything wrong; required values such as confidence stay required.
 */
function withEmptyDefaults(schema: z.ZodObject, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    if (key in out) continue;
    if (field.safeParse(null).success) out[key] = null;
    else if (field.safeParse([]).success) out[key] = [];
    else if (field.safeParse(false).success) out[key] = false;
  }
  return out;
}

/** Turns a tool call into the application's interpretation contract (still unvalidated). */
export function toolCallToInterpretation(call: { name: string; args: unknown } | null, forDocument: boolean): unknown {
  const intent = call ? TOOL_TO_INTENT[call.name] : undefined;
  if (!call || !intent || !call.args || typeof call.args !== "object") throw new AIError("AI_INVALID_RESPONSE");
  const { document_type, document_confidence, ...rest } = call.args as Record<string, unknown>;
  return {
    interpretation: { ...withEmptyDefaults(INTENT_SCHEMAS[intent], rest), intent },
    document: forDocument ? { type: document_type ?? "unknown", confidence: document_confidence ?? 0 } : null,
  };
}

const METHOD_WORDS: Record<string, RegExp> = { transferencia: /transf/i, efectivo: /efectivo|cash/i, cheque: /cheque/i, otro: /.^/ };

/**
 * Deterministic corrections for habits seen in this model: it fills the
 * payment method with the first enum value when nobody said one, and picks
 * the all-suppliers balance query even when the question names a supplier.
 */
function correctKnownSlips(result: AIInterpretationResult, userText: string, fileName?: string): AIInterpretationResult {
  if (fileName) result = withoutFileNameReferences(result, fileName);
  const i = result.interpretation;
  if ((i.intent === "create_supplier_payment" || i.intent === "pay_order_balance") && i.paymentMethod && !METHOD_WORDS[i.paymentMethod]!.test(userText)) {
    return { ...result, interpretation: { ...i, paymentMethod: null } };
  }
  // "Pay the whole balance" carries no amount; with an amount in sight the app must not compute a different one.
  if (i.intent === "pay_order_balance" && /\$\s?\d|\d[\d.]*\s*(mil|millones?)\b|importe/i.test(userText)) {
    const order = i.orderReference ? `del pedido ${i.orderReference}` : "del pedido";
    return {
      ...result,
      interpretation: {
        intent: "clarification_required",
        confidence: i.confidence,
        note: null,
        question: `¿El pago fue por el saldo completo ${order} o por el importe que figura? Escríbeme el importe y lo preparo.`,
        possibleIntent: "create_supplier_payment",
        missing: ["amount"],
      },
    };
  }
  if (i.intent === "ask_project_question" && i.query === "list_supplier_balances" && i.supplier) {
    return { ...result, interpretation: { ...i, query: "get_supplier_summary" } };
  }
  return result;
}

/** The model sometimes copies the attachment's file name into a reference field. */
function withoutFileNameReferences(result: AIInterpretationResult, fileName: string): AIInterpretationResult {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const fields = ["paymentReference", "deliveryReference", "orderReference"] as const;
  const interpretation = { ...result.interpretation } as Record<string, unknown>;
  for (const f of fields) {
    const v = interpretation[f];
    if (typeof v === "string" && (v.toLowerCase() === fileName.toLowerCase() || v.toLowerCase() === stem)) interpretation[f] = null;
  }
  return { ...result, interpretation: interpretation as AIInterpretationResult["interpretation"] };
}

const COMMON_INPUTS = {
  temperature: 0,
  // Reasoning tokens are billed as output; classification and extraction do not need them.
  chat_template_kwargs: { enable_thinking: false },
};

export class CloudflareAIProvider implements AIProvider {
  readonly id = "cloudflare" as const;
  readonly name = "cloudflare";
  readonly model?: string;
  readonly configured: boolean;
  private binding: WorkersAIBinding | null;
  private timeoutMs: number;

  constructor(options: CloudflareAIOptions = {}) {
    this.model = options.model;
    this.binding = asBinding(options.binding);
    this.configured = Boolean(this.binding && this.model);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private ready(): { binding: WorkersAIBinding; model: string } {
    if (!this.binding || !this.model) throw new AIError("AI_NOT_CONFIGURED");
    return { binding: this.binding, model: this.model };
  }

  private async classify(user: string, forDocument: boolean, op: string, said: string, fileName?: string): Promise<AIInterpretationResult> {
    const { binding, model } = this.ready();
    const started = Date.now();
    const raw = await callWorkersAI(
      binding,
      model,
      {
        ...COMMON_INPUTS,
        messages: [
          { role: "system", content: forDocument ? `${TOOL_INTERPRETATION_SYSTEM_PROMPT}\n\n${DOCUMENT_TOOL_NOTE}` : TOOL_INTERPRETATION_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        tools: intentTools(forDocument),
        tool_choice: "required",
        parallel_tool_calls: false,
        max_completion_tokens: 1500,
      },
      op,
      this.timeoutMs,
    );
    const result = correctKnownSlips(parseInterpretationResult(toolCallToInterpretation(firstToolCall(raw), forDocument)), said, fileName);
    return { ...result, meta: { provider: this.name, model, latencyMs: Date.now() - started } };
  }

  async interpret(input: AIInterpretationInput): Promise<AIInterpretationResult> {
    return this.classify(interpretationPrompt(input).user, false, "interpret", input.text);
  }

  async analyzeDocument(input: AIDocumentInput): Promise<AIInterpretationResult> {
    return this.classify(documentPrompt(input).user, true, "analyzeDocument", `${input.userText ?? ""}\n${input.content.text}`, input.document.fileName);
  }

  async answer(input: AIQuestionInput): Promise<AIAnswerResult> {
    const { binding, model } = this.ready();
    const started = Date.now();
    const raw = await callWorkersAI(
      binding,
      model,
      {
        ...COMMON_INPUTS,
        messages: [
          { role: "system", content: TOOL_ANSWER_SYSTEM_PROMPT },
          { role: "user", content: answerPrompt(input).user },
        ],
        tools: [
          {
            type: "function",
            function: { name: "reply", description: "Responder al usuario.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          },
        ],
        tool_choice: "required",
        max_completion_tokens: 600,
      },
      "answer",
      this.timeoutMs,
    );
    const call = firstToolCall(raw);
    const text = call?.name === "reply" ? (call.args as { text?: unknown } | undefined)?.text : completionText(raw);
    const result = parseAnswerResult({ text });
    return { ...result, meta: { provider: this.name, model, latencyMs: Date.now() - started } };
  }
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function capText(text: string): string {
  const t = text.trim();
  return t.length > MAX_EXTRACTED_CHARS ? `${t.slice(0, MAX_EXTRACTED_CHARS)}\n[…documento recortado…]` : t;
}

/**
 * PDFs go through `toMarkdown` (free for PDFs). Photos go to the vision model
 * with a transcription-only prompt (one call), or through `toMarkdown`'s image
 * description when no vision model is configured. One conversion per document.
 */
export class CloudflareDocumentContentExtractor implements DocumentContentExtractor {
  readonly id = "cloudflare";
  private binding: WorkersAIBinding | null;
  private maxBytes: number;
  private timeoutMs: number;

  constructor(
    private bytes: DocumentBytesSource,
    private options: CloudflareAIOptions = {},
  ) {
    this.binding = asBinding(options.binding);
    this.maxBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async extract(document: DocumentRecord): Promise<ExtractedDocumentContent> {
    if (!this.binding) throw new AIError("AI_NOT_CONFIGURED");
    if (!INTERPRETABLE_DOCUMENT_TYPES.has(document.mimeType)) throw new AIError("AI_DOCUMENT_UNSUPPORTED");
    if (document.sizeBytes > this.maxBytes) {
      throw new AIError("AI_DOCUMENT_CONVERSION_FAILED", `El archivo pesa más de ${Math.round(this.maxBytes / 1024 / 1024)} MB, el máximo que leo con IA.`);
    }
    const data = await this.bytes(document);
    if (document.mimeType !== "application/pdf" && this.options.visionModel) return this.transcribeImage(this.binding, this.options.visionModel, document, data);
    return this.toMarkdown(this.binding, document, data);
  }

  private async toMarkdown(binding: WorkersAIBinding, document: DocumentRecord, data: Uint8Array): Promise<ExtractedDocumentContent> {
    const started = Date.now();
    let results: Awaited<ReturnType<WorkersAIBinding["toMarkdown"]>>;
    try {
      results = await binding.toMarkdown([{ name: document.fileName, blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: document.mimeType }) }], {
        conversionOptions: { pdf: { metadata: false }, image: { descriptionLanguage: "es" } },
      });
    } catch (error) {
      const mapped = mapWorkersAIError(error);
      console.warn(JSON.stringify({ ai: "workers-ai", op: "toMarkdown", ms: Date.now() - started, error: mapped.code }));
      throw mapped.code === "AI_PROVIDER_UNAVAILABLE" ? new AIError("AI_DOCUMENT_CONVERSION_FAILED", undefined, error) : mapped;
    }
    const [result] = Array.isArray(results) ? results : [results];
    console.log(JSON.stringify({ ai: "workers-ai", op: "toMarkdown", mimeType: document.mimeType, ms: Date.now() - started, format: result?.format }));
    if (!result || result.format === "error") throw new AIError("AI_DOCUMENT_CONVERSION_FAILED", undefined, result?.error);
    return { format: result.format === "text" ? "text" : "markdown", text: capText(result.data ?? ""), extractor: "cloudflare-tomarkdown" };
  }

  private async transcribeImage(binding: WorkersAIBinding, model: string, document: DocumentRecord, data: Uint8Array): Promise<ExtractedDocumentContent> {
    const raw = await callWorkersAI(
      binding,
      model,
      {
        ...COMMON_INPUTS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: IMAGE_TRANSCRIPTION_PROMPT },
              { type: "image_url", image_url: { url: `data:${document.mimeType};base64,${toBase64(data)}` } },
            ],
          },
        ],
        max_completion_tokens: 2500,
      },
      "transcribeImage",
      this.timeoutMs,
    );
    const text = completionText(raw).trim();
    return { format: "markdown", text: text === "SIN_TEXTO" ? "" : capText(text), extractor: `cloudflare-vision:${model}` };
  }
}
