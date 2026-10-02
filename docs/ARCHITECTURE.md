# Architecture notes

## Layers

```
React UI ──► src/services/api (HTTP) ──► server/http/app.ts (Hono: validation, actor, error mapping)
                                              │
                    ┌─────────────────────────┼──────────────────────────┐
                    ▼                         ▼                          ▼
          services/queries.ts       services/commands.ts       services/assistant.ts
          (read models)             (validated writes)         (chat + proposals lifecycle)
                    │                         │                          │
                    ▼                         ▼                          ▼
          domain/derive.ts (Ledger)   WriteSet → db.batch()     ai/: provider → schemas →
          pure derivations            (+ audit rows, atomic)    proposals/answers/review
                    ▲                         │
                    └──── repositories/snapshot.ts ◄── Drizzle (SQLite / D1)
```

- **Transport** (`server/http`) only parses input with Zod, resolves the actor and maps `DomainError`s to JSON `{ error: { code, message } }` with Spanish messages.
- **Commands** (`server/services/commands.ts`) re-read current state, check business rules and write records **and their audit entries in a single `batch()`** (atomic on libsql and on D1, which has no interactive transactions).
- **Read models** are derived on request: the project's working set is loaded (`repositories/snapshot.ts`, joins instead of `IN (…)` lists to respect D1's parameter limit) and `domain/derive.ts` computes every status and balance. A construction project has hundreds to a few thousand rows, so this keeps the rules in plain, unit-testable functions. If the data grows, the same functions can be fed by narrower queries.

## Domain rules

- **Money**: integer minor units (`*_minor`, centavos) + currency (`ARS`) everywhere — DB, API and UI. `formatMoney` divides by 100 only for display; inputs are parsed from text without floats. Line totals use `BigInt` (`price × quantity`).
- **Quantities**: integer thousandths (`*_milli`) in the database, so sums/comparisons are exact (6,5 m³ = 6500).
- **Orders** record that an order *happened* (no approval workflow). Value = supplier-stated total, else the sum of line totals when every line is priced, else **unknown** (`null`) — never invented.
- **Deliveries** are independent of payments. Per order line: `ordered`, `delivered = Σ delivery items`, `remaining`. Order state (`pendiente` / `parcial` / `entregado`) is derived; there is no mutable status column. Delivering more than what remains is rejected.
- **Payments** are independent of deliveries and may have zero, one or many `payment_allocations` (Σ allocations ≤ payment; an allocation never exceeds an order's known balance).
  - Supplier balance = Σ known order values − Σ **all** payments (allocated or not).
  - Order paid/pending uses only allocations to that order; unallocated payments lower the supplier balance but never make an order look paid.
  - Orders with unknown value are counted separately (`unknownValueOrders`) and surfaced, so the total is never falsely precise.
- **Materials**: normalized catalog with aliases (`material_aliases`) and optional rational unit conversions (`unit_conversions`, e.g. barra → m / kg). Quantities in another unit are converted only when a conversion exists.
- **Computation**: one baseline per project (`computations` + `computation_items`), every change appends a `computation_revisions` row (previous → new, actor, reason). Comparisons (expected incl. waste, ordered, delivered, %, remaining, variation, status) are derived, so historical orders are compared as soon as a quantity exists — no migration or reassignment. Exceeding is an *attention* item; "Marcar como revisado" silences it until more is ordered.
- **Undo** never deletes: records are voided (`voided_at`) and excluded from derivations; voiding an order with deliveries or allocations is blocked. The audit log is append-only.
- **Audit**: every confirmed mutation writes `audit_log` rows with actor, source (`assistant` / `manual` / `seed`), the AI interpretation id when applicable, before/after changes and reason. The Actividad screen and order history are views over it.

## AI pipeline (write safety)

```
message / document
  → AIProvider.interpret / analyzeDocument        (extracts mentions only; Zod-validated ExtractionSchema)
  → ai/proposals.ts                               (application-owned matching: supplier, material, order;
                                                   remaining quantities, balances, allocation previews)
  → ai_interpretations row (status pending)       (nothing in the domain tables yet)
  → proposal card in the UI (editable)            → /revise re-resolves edited supplier/material/order
  → user confirms → ai/review.ts                  → same validated commands as manual forms
  → batch write + audit (source "assistant", ai_interpretation_id) → row marked confirmed
```

- Read-only questions (`ask_query`) are answered by `ai/answers.ts` from the database (balances, pending deliveries, material quantities, computation status, order status, unallocated payments). The model only classifies the question; free-form questions go to `AIProvider.answer` with a summary of verified figures.
- Weak matches are never auto-confirmed: they are flagged (`Verificar`), carry candidates, and the user resolves them; materials are only created when shown as *Material nuevo*. Confirmed wordings are stored as aliases so the next match is strong.
- "Pagamos completo el pedido X" proposes exactly the order's known outstanding allocated balance; if the value is unknown the assistant explains it and proposes nothing.
- Document receipts without an order number are suggested for an order only when the amount equals its balance exactly (flagged); otherwise they are proposed unallocated.
- Errors (provider unavailable, malformed output, unsupported/unreadable document, unresolved supplier/material/order, invalid quantity, persistence failure, unknown order value) produce Spanish messages; structured screens keep working without AI.
- Chat history is persisted for display only (`conversations`, `chat_messages`, `message_attachments`); interpretation cards are re-hydrated from `ai_interpretations` so a reload shows their real state. Domain tables are the source of truth.

### Providers

- `AIProvider` (`server/ai/provider.ts`): `interpret`, `analyzeDocument`, `answer`. Domain code depends only on this interface and on `ExtractionSchema`.
- `AnthropicAIProvider`: `client.beta.messages.parse` with Zod structured outputs (`betaZodOutputFormat`), PDF `document` / image `image` base64 blocks, `output_config.effort` (`AI_EFFORT`, default `low`; documents use at least `medium`), server-side refusal fallback (`fallbacks: "default"`), typed SDK errors mapped to `AIUnavailableError` / `AIMalformedResponseError`. Output is validated again with the application schema. Uses only fetch/Web APIs.
- `MockAIProvider`: deterministic Spanish rules; reads text from simple PDFs (the seed and `samples/` files). Used by tests and when no key is configured.

## Documents

`DocumentStorage` (`put/get/delete`) hides the bytes; the `documents` table holds metadata (kind, mime, size, sha256, storage key) and `document_links` ties evidence to an order, delivery or payment (exactly one target, enforced by a CHECK). Uploads are validated by magic number and size (20 MB). A document is linked — and audited — only when the record it supports is confirmed.

## Identity

`server/http/auth.ts` resolves an `Actor` per request. `AUTH_MODE=dev` uses a fixed development user; `AUTH_MODE=cloudflare-access` maps the `Cf-Access-Authenticated-User-Email` header to a `users` row with `can_login`; `basic` (production) checks HTTP Basic credentials against password hashes held in a Worker secret. No passwords are stored in the database.

## Cloudflare deployment

Deployed as one Worker (`server/worker.ts`, config in `wrangler.jsonc`); see the README for commands, access model and free-tier limits.

- **D1**: `drizzle(env.DB, { schema })` from `drizzle-orm/d1` satisfies `AppDb`. Migrations are the same `drizzle/*.sql` files, applied with `wrangler d1 migrations apply` (tracked in `d1_migrations`; locally the libsql migrator tracks them in `__drizzle_migrations`). FKs are always enforced on D1.
- **R2**: `R2Storage` (`server/storage/r2.ts`) implements `DocumentStorage`; without a `DOCUMENTS` binding, `UnavailableStorage` makes uploads fail with a Spanish message. Production passes `documentLimits` (size, uploads per day, total bytes) to `storeDocument`.
- **Static assets**: the Vite build in `dist/`, SPA fallback via `not_found_handling: "single-page-application"`, `run_worker_first: true` so the login gate covers every path.
- **Identity**: `AUTH_MODE` `basic` — `basicAuthEmail` checks the `Authorization` header against SHA-256 hashes in the `APP_USERS` secret; the e-mail must match a `users` row with `can_login`. The Worker accepts only this mode (a bare Access e-mail header would be spoofable without JWT validation).
- **AI**: `AI_PROVIDER=disabled` → `DisabledAIProvider`, which throws `AINotConfiguredError`; the assistant shows «La función de IA todavía no está configurada. No se guardó nada.» The provider abstraction is unchanged; a later deployment sets `AI_PROVIDER=anthropic` plus an `ANTHROPIC_API_KEY` secret.
- **Bootstrap**: `server/bootstrap.ts` writes idempotent SQL for the project, login users and units only.

## Known limitations

- Single project and a small team; no roles/permissions beyond the identity boundary.
- Read models load the whole project working set per request (fine for one house; revisit for large datasets).
- Unit conversions are modeled and applied in comparisons, but there is no UI to manage them (seeded for steel bars).
- The mock provider understands common phrasings and simple text PDFs only; photos and scanned PDFs need the Anthropic provider. HEIC files are stored but not analyzed (the user is asked for JPG/PNG/PDF).
- No AI intent for correcting an existing order by chat; corrections use the *Corregir pedido* sheet (audited).
- Deliveries without a known order are supported by the domain command, but neither the HTTP endpoint nor the assistant creates them yet (the assistant asks for the order).
- Computation upload accepts CSV/XLSX (first sheet); PDF computations are not parsed.
- Allocations can be undone from the assistant right after confirming; there is no screen to re-assign old allocations (void + allocate again via API).
- The Anthropic provider was verified against a stubbed transport and a live authentication-error round trip; no API key was available to run it against real model output in this environment.

## End-to-end scenarios verified

Automated in `tests/` (`npm test`, 28 tests, real SQLite + HTTP app + mock provider), and checked in the browser with Playwright (every screen on desktop and mobile; the assistant, document, correction, delivery, payment and computation-import flows on desktop):

| Scenario | Verified |
| --- | --- |
| **A** create order from text | proposal with matched supplier/materials, edits (number, price), nothing saved before confirm, order + items persisted, value stays unknown when a price is missing, audit row with source `assistant` and interpretation id, double confirm rejected; new material created only when marked new |
| **B** partial delivery | «Del pedido 38 llegaron…» → order 38 matched, Ø12 complete, Ø10 5 pending, state `parcial`, payment state unchanged; order inferred from material when no number; over-delivery reduced with a visible note and rejected by the domain |
| **C** complete remaining | only the 5 pending Ø10 proposed; order becomes `entregado`; a further "todo lo pendiente" proposes nothing |
| **D** account payment | unallocated proposal, balance preview, balance −$500.000 after confirm, unallocated +$500.000, order balances untouched |
| **E** pay order | 381 → $882.340 (value − allocated, ignoring unallocated payments) → `pagado`; 38 → $1.482.340; unknown value (0035) → no invented amount; split payment across two orders |
| **F** documents | remito PDF stored via storage abstraction, analyzed, matched to order 38 with remito number, no writes before confirm, linked to the delivery after; payment receipt matched to referenced order; receipt without reference matched only on exact balance (flagged); order proof → order with prices; unreadable photo → read error; unsupported format → 415 |
| **G** no computation | orders, deliveries, payments and balances work with an empty catalog project; materials `sin_computo` |
| **H** later computation | adding Ø12 = 18 immediately compares the historical 20 (111%, supera); revising to 24 keeps both revisions; activity shows both |
| Integrity | FK and CHECK constraints enforced inside batches; negative amounts rejected; allocations above payment / order balance / to another supplier rejected; later allocation of an unallocated payment keeps supplier balance; undo voids and keeps audit; voiding an order with deliveries blocked; price correction audited and enables "pagar completo"; quantity below delivered rejected; read queries write nothing; CSV computation import with alias match and new material |
| AI unavailable | Anthropic provider with an invalid key returns the Spanish "asistente no disponible" message; the rest of the API keeps serving |
