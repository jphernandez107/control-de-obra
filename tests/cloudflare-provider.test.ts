import { describe, expect, it } from "vitest";
import { CloudflareAIProvider, CloudflareDocumentContentExtractor, mapWorkersAIError, type WorkersAIBinding } from "../server/ai/cloudflare";
import type { AIError } from "../server/ai/errors";
import type { AIInterpretationInput } from "../server/ai/provider";
import type { AssistantBlock } from "../src/domain/assistant";
import { setup } from "./helpers";

const MODEL = "@cf/zai-org/glm-4.7-flash";

function toolCall(name: string, args: unknown) {
  return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
}

function binding(run: WorkersAIBinding["run"], toMarkdown?: WorkersAIBinding["toMarkdown"]): WorkersAIBinding & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    run: async (model, inputs) => {
      calls.push({ model, inputs });
      return run(model, inputs);
    },
    toMarkdown: toMarkdown ?? (async () => []),
  };
}

const input: AIInterpretationInput = {
  text: "Pagamos completo el pedido 38",
  project: { today: "2026-10-02", suppliers: ["Hierros Córdoba"], materials: [], openOrders: [] },
  conversation: { recent: [], focus: {} },
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (e) {
    return (e as AIError).code;
  }
}

describe("CloudflareAIProvider", () => {
  it("turns a proposal tool call into a validated interpretation, filling unsaid fields with null", async () => {
    const ai = binding(async () => toolCall("propose_order_payment", { confidence: 0.9, orderReference: "38" }));
    const provider = new CloudflareAIProvider({ binding: ai, model: MODEL });
    expect(provider.configured).toBe(true);
    const result = await provider.interpret(input);
    expect(result.interpretation).toMatchObject({ intent: "pay_order_balance", orderReference: "38", supplier: null, date: null });
    expect(result.meta).toMatchObject({ provider: "cloudflare", model: MODEL });
    expect(ai.calls).toHaveLength(1);
  });

  it("rejects unknown tools and schema-invalid arguments without retrying", async () => {
    const unknownTool = binding(async () => toolCall("create_invoice", { confidence: 1 }));
    expect(await codeOf(new CloudflareAIProvider({ binding: unknownTool, model: MODEL }).interpret(input))).toBe("AI_INVALID_RESPONSE");
    const invalid = binding(async () => toolCall("propose_supplier_payment", { confidence: 1, supplier: "Hierros Córdoba", amount: "500000" }));
    expect(await codeOf(new CloudflareAIProvider({ binding: invalid, model: MODEL }).interpret(input))).toBe("AI_INVALID_RESPONSE");
    expect(invalid.calls).toHaveLength(1);
    const text = binding(async () => ({ response: "no sé" }));
    expect(await codeOf(new CloudflareAIProvider({ binding: text, model: MODEL }).interpret(input))).toBe("AI_INVALID_RESPONSE");
  });

  it("maps Workers AI failures to application errors", async () => {
    const quota = binding(async () => {
      throw new Error("3036: You have used up your daily free allocation of 10,000 neurons.");
    });
    expect(await codeOf(new CloudflareAIProvider({ binding: quota, model: MODEL }).interpret(input))).toBe("AI_QUOTA_EXCEEDED");
    expect(quota.calls).toHaveLength(1);
    expect(mapWorkersAIError(new Error("5035: This model requires a Workers Paid plan.")).code).toBe("AI_MODEL_UNAVAILABLE");
    expect(mapWorkersAIError(new Error("5007: No such model @cf/x")).code).toBe("AI_MODEL_UNAVAILABLE");
    expect(mapWorkersAIError(new Error("3040: Capacity temporarily exceeded, please try again.")).code).toBe("AI_TEMPORARILY_UNAVAILABLE");
    expect(mapWorkersAIError(new TypeError("fetch failed")).code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(await codeOf(new CloudflareAIProvider({ model: MODEL }).interpret(input))).toBe("AI_NOT_CONFIGURED");
  });

  it("corrects known model slips deterministically", async () => {
    const unsaidMethod = binding(async () => toolCall("propose_supplier_payment", { confidence: 0.9, supplier: "Hierros Córdoba", amount: 500000, paymentMethod: "transferencia", toCurrentAccount: true }));
    const payment = await new CloudflareAIProvider({ binding: unsaidMethod, model: MODEL }).interpret({ ...input, text: "Pagamos $500.000 a Hierros Córdoba" });
    expect(payment.interpretation).toMatchObject({ intent: "create_supplier_payment", paymentMethod: null });

    const balanceWithAmount = binding(async () => toolCall("propose_order_payment", { confidence: 0.9, orderReference: "381", document_type: "payment", document_confidence: 0.9, paymentReference: "transferencia_381" }));
    const fromReceipt = await new CloudflareAIProvider({ binding: balanceWithAmount, model: MODEL }).analyzeDocument({
      document: { id: "d1", fileName: "transferencia_381.pdf", mimeType: "application/pdf" },
      content: { format: "markdown", text: "Comprobante de transferencia\nImporte: $350.000\nConcepto: pago pedido 381", extractor: "test" },
      project: input.project,
      conversation: input.conversation,
    });
    expect(fromReceipt.interpretation).toMatchObject({ intent: "clarification_required", possibleIntent: "create_supplier_payment", missing: ["amount"] });
  });

  it("answers through the reply tool", async () => {
    const ai = binding(async () => toolCall("reply", { text: "Le debemos $ 2.982.340." }));
    const answer = await new CloudflareAIProvider({ binding: ai, model: MODEL }).answer({ question: "¿Cuánto debemos?", today: "2026-10-02", results: [], conversation: { recent: [], focus: {} } });
    expect(answer.text).toBe("Le debemos $ 2.982.340.");
  });

  it("shows the quota message in the assistant and keeps nothing pending", async () => {
    const quota = binding(async () => {
      throw new Error("3036: daily free allocation");
    });
    const { say, get } = await setup({ ai: new CloudflareAIProvider({ binding: quota, model: MODEL }) });
    const reply = await say("Llegaron 5 barras del 10");
    expect((reply.reply.blocks as AssistantBlock[])[0]).toMatchObject({ type: "ai_error", code: "AI_QUOTA_EXCEEDED", message: expect.stringContaining("cuota gratuita de IA de hoy se agotó") });
    expect((await get("/assistant/pending-actions?status=pending")).actions ?? []).toHaveLength(0);
  });
});

describe("CloudflareDocumentContentExtractor", () => {
  const doc = (mimeType: string, sizeBytes = 1000) => ({ id: "d1", fileName: "remito.pdf", mimeType, sizeBytes, sha256: "abc" });
  const bytes = async () => new Uint8Array([1, 2, 3]);

  it("converts PDFs with toMarkdown and photos with the vision model", async () => {
    const ai = binding(
      async () => ({ choices: [{ message: { content: "REMITO 0001-123\n| Material | Cantidad |" } }] }),
      async () => [{ name: "remito.pdf", format: "markdown", data: "# Remito\nPedido N° 38" }],
    );
    const extractor = new CloudflareDocumentContentExtractor(bytes, { binding: ai, visionModel: "@cf/google/gemma-4-26b-a4b-it" });
    expect(await extractor.extract(doc("application/pdf"))).toMatchObject({ format: "markdown", text: "# Remito\nPedido N° 38", extractor: "cloudflare-tomarkdown" });
    expect(ai.calls).toHaveLength(0);
    expect((await extractor.extract(doc("image/jpeg"))).text).toContain("REMITO 0001-123");
    expect(ai.calls).toHaveLength(1);
  });

  it("refuses unsupported, oversized and unconvertible documents", async () => {
    const ai = binding(async () => ({}), async () => [{ format: "error", error: "bad pdf" }]);
    const extractor = new CloudflareDocumentContentExtractor(bytes, { binding: ai, maxDocumentBytes: 2000 });
    expect(await codeOf(extractor.extract(doc("application/zip")))).toBe("AI_DOCUMENT_UNSUPPORTED");
    expect(await codeOf(extractor.extract(doc("application/pdf", 5000)))).toBe("AI_DOCUMENT_CONVERSION_FAILED");
    expect(await codeOf(extractor.extract(doc("application/pdf")))).toBe("AI_DOCUMENT_CONVERSION_FAILED");
  });
});
