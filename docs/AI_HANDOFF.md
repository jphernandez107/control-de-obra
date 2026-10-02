# AI handoff: connecting Cloudflare Workers AI

> **Status (2026-10-02): done.** `server/ai/cloudflare.ts` implements both adapters, the `AI` binding is in
> `wrangler.jsonc`, and production runs `AI_PROVIDER=cloudflare` with `@cf/zai-org/glm-4.7-flash` (text) and
> `@cf/google/gemma-4-26b-a4b-it` (photos). Operation, limits and costs: README → *AI in production*. The notes
> below are kept as the contract the adapter follows.

This is for the agent that has Cloudflare access. The application side of the AI
assistant is complete. It runs end to end with the deterministic `MockAIProvider`
(`AI_PROVIDER=mock`), and production currently runs with `AI_PROVIDER=disabled`.

**What is left:** a Workers AI adapter, a document-to-text adapter, a binding,
a model choice, error mapping and a deploy. Do **not** change intent schemas, matching,
proposals, confirmation, the read-only queries or the frontend. They are
provider-independent and covered by tests.

## What already exists

```
message / document
  → DocumentContentExtractor.extract(document)      server/ai/document-content.ts   (documents only: bytes → text/markdown)
  → AIProvider.interpret / analyzeDocument          server/ai/provider.ts           (classify intent + extract mentions)
  → parseInterpretationResult(raw)                  server/ai/schemas.ts            (Zod; malformed → AI_INVALID_RESPONSE)
  → proposals / answers                             server/ai/proposals.ts, answers.ts
        matching:  server/domain/matching.ts, server/ai/resolve.ts
        figures:   server/domain/summaries.ts, server/ai/project-queries.ts (read-only, no SQL)
        context:   server/ai/conversation-context.ts (last turns + focused record ids)
  → pending AI action (ai_interpretations, status pending, validation)   server/ai/pending-actions.ts
  → review card in the UI (edit → /revise re-resolves and re-validates)
  → explicit confirm → revalidate + recompute + stale check (server/ai/review.ts)
  → domain command → db.batch() with audit rows (metadata.origin = "ai", pendingActionId)
```

Provider selection is a single boundary, `server/ai/factory.ts`:

```ts
getAIProvider({ provider: "mock" | "cloudflare" | "disabled", model?, cloudflareBinding? })
getDocumentContentExtractor(config, bytes)
```

`server/worker.ts` already reads `AI_PROVIDER`, `AI_MODEL` and an optional `env.AI`, and passes
them to the factory. `AI_PROVIDER=cloudflare` is valid today. It selects the placeholders in
`server/ai/cloudflare.ts`, which throw `AI_NOT_CONFIGURED`, so the UI shows
«La función de IA todavía no está configurada.»

## What to implement

### 1. `CloudflareAIProvider` (`server/ai/cloudflare.ts`)

Each method follows the same shape. Prompts and JSON schemas are already built in
`server/ai/prompts.ts`. The snippets below are sketches: check the current Workers AI docs for the exact
binding signatures and the JSON-mode support of the chosen model.

```ts
async interpret(input) {
  const p = interpretationPrompt(input);              // documentPrompt(input) for analyzeDocument, answerPrompt(input) for answer
  const started = Date.now();
  const raw = await this.binding.run(this.model, {
    messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
    response_format: { type: "json_schema", json_schema: p.jsonSchema },   // JSON mode, if the chosen model supports it
  });
  const json = /* raw.response (string or object, depending on the model) */;
  return parseInterpretationResult({ ...JSON.parse(json), meta: { provider: "cloudflare", model: this.model, latencyMs: Date.now() - started } });
}
```

- Use `parseInterpretationResult` / `parseAnswerResult`. They are the trust boundary. Never hand raw model output to proposals.
- Set `configured = true` once a binding is present (it drives the UI notice and `/api/session`).
- `analyzeDocument` receives **text** (`input.content.text`), never bytes. Image understanding happens in the extractor.
- `answer` is only used for free-form ("general") questions. It gets read-only query results, and its text is shown as-is. All specific questions (balances, pending deliveries, materials) are answered deterministically without the model.
- If the chosen model is weak at the discriminated union, keep the schema and add a retry with the validation issues. Do not loosen the schema.

### 2. `CloudflareDocumentContentExtractor` (`server/ai/cloudflare.ts`)

```ts
async extract(document) {
  const data = await this.bytes(document);                     // already resolves storage (R2) + metadata
  const [result] = await this.binding.toMarkdown([{ name: document.fileName, blob: new Blob([data], { type: document.mimeType }) }]);
  return { format: "markdown", text: result.data ?? "", extractor: "cloudflare" };
}
```

- Empty text is fine: the assistant shows the "No pude leer el comprobante" card.
- Formats the extractor cannot read → throw `new AIError("AI_DOCUMENT_UNSUPPORTED")`.
- Accepted upload types are in `server/services/documents.ts`. Interpretable types are listed in `INTERPRETABLE_DOCUMENT_TYPES`.

### 3. Error mapping (inside the adapters only)

| Situation | Throw |
| --- | --- |
| No binding / model not configured | `AIError("AI_NOT_CONFIGURED")` |
| Daily neuron / rate limit reached (e.g. 429, error 4006) | `AIError("AI_QUOTA_EXCEEDED")` |
| Network error, 5xx, timeout | `AIError("AI_PROVIDER_UNAVAILABLE")` |
| Unparsable / schema-invalid output | let `parse*Result` throw `AI_INVALID_RESPONSE` |
| Document format not supported | `AIError("AI_DOCUMENT_UNSUPPORTED")` |

`AI_INTERPRETATION_AMBIGUOUS` is raised by the application when a document's classification or the
interpretation confidence is below 0.5. Providers only need to report honest `confidence` values.
Anything else a provider throws is mapped to `AI_PROVIDER_UNAVAILABLE` by `toAIError`.
The Spanish messages live in `server/ai/errors.ts`.

### 4. Configuration and deploy

- `wrangler.jsonc`: add the Workers AI binding (`"ai": { "binding": "AI" }`), set `vars.AI_PROVIDER` to `"cloudflare"` and `vars.AI_MODEL` to the chosen model.
- `server/worker.ts` already passes `env.AI` as `cloudflareBinding`. Type it properly if you add `@cloudflare/workers-types`' `Ai`.
- Apply the new migration before deploying: `npm run cf:migrate`. `drizzle/0001_pending_ai_actions.sql` only adds nullable columns.
- Review the Workers AI free allowance and pricing first. The README's cost section currently lists Workers AI as "not used".

## Contracts you can rely on

- **Intents** (`server/ai/schemas.ts`): `create_order`, `register_delivery`, `complete_order_delivery`,
  `create_supplier_payment`, `pay_order_balance`, `allocate_payment`, `ask_project_question`,
  `clarification_required`, `unknown`. Document types: `order`, `delivery`, `payment`, `unknown` (no invoices).
- **The model never calculates.** `complete_order_delivery` and `pay_order_balance` carry no quantities or amounts. The
  application computes remaining quantities and balances from the database, and recomputes them at confirmation.
  A stale proposal is refused (`409 stale_proposal`) and the card is refreshed for review.
- **Read-only queries** (`server/ai/project-queries.ts`): `get_supplier_summary`, `list_supplier_balances`,
  `get_order_summary`, `list_orders_pending_delivery`, `list_delivered_unpaid_orders`, `get_material_summary`,
  `get_computation_variance`, `list_unallocated_payments`. `projectQueryTools()` exports them as tool
  definitions (name, description, JSON Schema) if you later prefer tool calling, and `GET /api/queries/:name` serves them.
- **Pending actions**: `GET /api/assistant/pending-actions?status=pending|confirmed|cancelled|undone`.

## How to verify

```bash
npm test                     # 55 tests, including tests/ai-architecture.test.ts (contract, errors, matching, queries, follow-ups, stale checks, Scenario F)
AI_PROVIDER=mock npm run dev # full flow locally, no network
```

For the Cloudflare adapter, add a test that stubs the binding (`{ run: async () => ({ response: "…json…" }) }`) and
checks that valid JSON becomes a proposal, invalid JSON becomes `AI_INVALID_RESPONSE`, and a thrown 429 becomes `AI_QUOTA_EXCEEDED`.
Then try the canonical messages from the README on the deployed Worker.
