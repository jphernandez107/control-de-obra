import { describe, expect, it } from "vitest";
import { AnthropicAIProvider } from "../server/ai/anthropic";
import { AIMalformedResponseError, AIUnavailableError, type AIContext } from "../server/ai/provider";
import { emptyExtraction } from "../server/ai/schemas";

// The Anthropic adapter is exercised against a stubbed transport (no API key
// in CI): request shape, structured-output parsing, validation and errors.

const context: AIContext = { today: "2026-10-02", suppliers: ["Hierros Córdoba"], materials: [{ name: "Acero Ø12", unit: "barras", aliases: ["hierro del 12"] }], openOrders: [] };

function stub(responder: (body: any) => { status: number; json: unknown }) {
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ body, headers: new Headers(init.headers) });
    const { status, json } = responder(body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function message(text: string, stop_reason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

describe("AnthropicAIProvider", () => {
  it("sends structured-output requests and validates the result", async () => {
    const extraction = { ...emptyExtraction("create_order"), confidence: 0.9, supplier: "Hierros Córdoba", items: [{ material: "barras del 12", quantity: 20, unit: "barras", unitPrice: null }] };
    const { fetchImpl, calls } = stub(() => ({ status: 200, json: message(JSON.stringify(extraction)) }));
    const provider = new AnthropicAIProvider({ apiKey: "test", fetch: fetchImpl, baseURL: "https://api.test" });
    const result = await provider.interpret({ text: "Marcelo pidió 20 barras del 12 a Hierros Córdoba", context });
    expect(result.intent).toBe("create_order");
    expect(result.items[0]!.quantity).toBe(20);
    const req = calls[0]!.body;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.fallbacks).toBe("default");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.output_config.effort).toBe("low");
    expect(calls[0]!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.messages[0].content[0].text).toContain("Hierros Córdoba");
  });

  it("sends PDFs as document blocks and images as image blocks", async () => {
    const { fetchImpl, calls } = stub(() => ({ status: 200, json: message(JSON.stringify({ ...emptyExtraction("register_delivery"), documentType: "delivery_proof" })) }));
    const provider = new AnthropicAIProvider({ apiKey: "test", fetch: fetchImpl, baseURL: "https://api.test" });
    await provider.analyzeDocument({ fileName: "remito.pdf", mimeType: "application/pdf", data: new TextEncoder().encode("%PDF-1.4"), context });
    await provider.analyzeDocument({ fileName: "foto.jpg", mimeType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]), context });
    expect(calls[0]!.body.messages[0].content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf", data: btoa("%PDF-1.4") } });
    expect(calls[1]!.body.messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg" } });
    expect(calls[0]!.body.output_config.effort).toBe("medium");
  });

  it("maps provider failures to application errors", async () => {
    const unavailable = new AnthropicAIProvider({ apiKey: "test", fetch: stub(() => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "bad key" } } })).fetchImpl, baseURL: "https://api.test" });
    await expect(unavailable.interpret({ text: "hola", context })).rejects.toBeInstanceOf(AIUnavailableError);
    const malformed = new AnthropicAIProvider({ apiKey: "test", fetch: stub(() => ({ status: 200, json: message(JSON.stringify({ intent: "volar" })) })).fetchImpl, baseURL: "https://api.test" });
    await expect(malformed.interpret({ text: "hola", context })).rejects.toBeInstanceOf(AIMalformedResponseError);
    const refused = new AnthropicAIProvider({ apiKey: "test", fetch: stub(() => ({ status: 200, json: { ...message(""), content: [], stop_reason: "refusal" } })).fetchImpl, baseURL: "https://api.test" });
    await expect(refused.interpret({ text: "hola", context })).rejects.toBeInstanceOf(AIUnavailableError);
  });
});
