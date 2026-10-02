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

The AI is not the source of truth: it classifies what the user means and extracts what was said or printed. Every record, match and figure comes from the application. The Cloudflare handoff is described in [AI_HANDOFF.md](AI_HANDOFF.md).

```
message / document
  → DocumentContentExtractor.extract          (documents only: bytes → normalized text; ai/document-content.ts)
  → AIProvider.interpret / analyzeDocument    (application-owned input: text, project context, short conversation context)
  → parseInterpretationResult                 (Zod discriminated union; anything else → AI_INVALID_RESPONSE)
  → ai/proposals.ts | ai/answers.ts           (deterministic matching + figures from domain/summaries.ts)
  → pending AI action (ai_interpretations, status pending, validation_state, warnings, unresolved_fields)
  → review card (editable) → /revise re-resolves supplier/material/order and re-validates
  → explicit confirm → revise + recompute + stale check + validation (ai/review.ts, ai/pending-actions.ts)
  → same domain commands as manual forms → db.batch() with audit rows (source "assistant",
    ai_interpretation_id, metadata { origin: "ai", pendingActionId }) → action marked confirmed
```

- **Intents** (`ai/schemas.ts`): `create_order`, `register_delivery`, `complete_order_delivery`, `create_supplier_payment`, `pay_order_balance`, `allocate_payment`, `ask_project_question`, `clarification_required`, `unknown`. Documents are classified as `order`, `delivery`, `payment` or `unknown`. Unknown fields stay `null`; the schemas have no transforms so they double as JSON schemas for a model.
- **The provider never calculates.** «Se entregó todo lo pendiente del pedido 38» and «Pagamos completo el pedido 38» carry only the order. Remaining quantities and the outstanding allocated balance come from `domain/summaries.ts`. An unknown order value produces an explanation, never an amount.
- **Confirmation revalidates.** Proposals are re-resolved and re-validated (`validateInterpretation`). A blocked proposal cannot be confirmed. If the data changed since the proposal (e.g. someone paid part of the order, or registered part of the delivery), the confirmation is refused with `409 stale_proposal` and the refreshed proposal is returned to the card.
- **Matching** (`domain/matching.ts`, `ai/resolve.ts`): suppliers by exact normalized name → alias → fuzzy; materials by name/alias/short name plus diameter heuristics («hierro del 12», «acero 12 mm», «barra Ø12», «Ø12»); orders by explicit reference, otherwise ranked by supplier, item overlap, quantity fit and date (`rankOrders`). Weak matches are flagged with candidates, close candidates are asked about, and nothing is created silently.
- **Read-only questions** (`ai/project-queries.ts`): eight named queries (`get_supplier_summary`, `list_supplier_balances`, `get_order_summary`, `list_orders_pending_delivery`, `list_delivered_unpaid_orders`, `get_material_summary`, `get_computation_variance`, `list_unallocated_payments`) return structured data, with no SQL surface. `ai/answers.ts` renders them in Spanish deterministically. Only free-form questions go to `AIProvider.answer`, and only with query results. They are also available as tool definitions (`projectQueryTools()`) and at `GET /api/queries/:name`.
- **Conversation context** (`ai/conversation-context.ts`): the provider gets the last few turns (truncated) plus the record the latest reply was about. Replies store only record ids (`chat_messages.context_refs`), so «¿Y cuánto falta pagar?» after «¿Cómo viene el pedido 38?» is answered from fresh data. When the latest reply was about several records, the assistant asks.
- **Errors** (`ai/errors.ts`): `AI_NOT_CONFIGURED`, `AI_PROVIDER_UNAVAILABLE`, `AI_QUOTA_EXCEEDED`, `AI_INVALID_RESPONSE`, `AI_DOCUMENT_UNSUPPORTED`, `AI_INTERPRETATION_AMBIGUOUS`, each with a Spanish message and hint rendered as an `ai_error` card. The rest of the application works without AI.
- Chat history is persisted for display (`conversations`, `chat_messages`, `message_attachments`). Interpretation cards are re-hydrated from `ai_interpretations`, so a reload shows their real state. Unconfirmed proposals are never project history; domain tables are the source of truth.

### Providers (`AI_PROVIDER`)

- `mock` — `MockAIProvider`: deterministic Spanish rules for the canonical phrasings, follow-ups and clarifications; documents via `LocalDocumentContentExtractor` (text of simple PDFs; photos yield no text). Local default and used by tests.
- `cloudflare` — `CloudflareAIProvider` / `CloudflareDocumentContentExtractor` (`ai/cloudflare.ts`): integration point for Workers AI, currently placeholders that report `AI_NOT_CONFIGURED`.
- `disabled` — `DisabledAIProvider`: production default until Workers AI is connected.

No external AI API is called by this codebase.

## Documents

`DocumentStorage` (`put/get/delete`) hides the bytes; the `documents` table holds metadata (kind, mime, size, sha256, storage key) and `document_links` ties evidence to an order, delivery or payment (exactly one target, enforced by a CHECK). Uploads are validated by magic number and size (20 MB). A document is linked — and audited — only when the record it supports is confirmed.

## Identity

`server/http/auth.ts` resolves the acting user per request. In `session` mode (local default and production) people sign in with a username and password (`POST /api/auth/login`). The password is checked against a salted PBKDF2-SHA256 hash in `users.password_hash`. Success sets an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production) with a random token; `sessions` stores only its SHA-256 with a 30-day expiry that is extended while in use. Every other `/api` route requires a valid session (401 otherwise); `POST /api/auth/logout` deletes it. Failed attempts are counted per username in `login_attempts` (10 in 15 minutes → 429). `users.is_admin` gates `GET/POST /api/users` (403 otherwise), which list people who can sign in and add new ones. `dev` mode skips the login and acts as `DEV_USERNAME` (used by most tests).

The frontend wraps the app in `AuthGate`: a 401 from `/api/session` renders the login screen at the current URL, and any later 401 re-checks the session.

## Cloudflare deployment

Deployed as one Worker (`server/worker.ts`, config in `wrangler.jsonc`); see the README for commands, access model and free-tier limits.

- **D1**: `drizzle(env.DB, { schema })` from `drizzle-orm/d1` satisfies `AppDb`. Migrations are the same `drizzle/*.sql` files, applied with `wrangler d1 migrations apply` (tracked in `d1_migrations`; locally the libsql migrator tracks them in `__drizzle_migrations`). FKs are always enforced on D1.
- **R2**: `R2Storage` (`server/storage/r2.ts`) implements `DocumentStorage`; without a `DOCUMENTS` binding, `UnavailableStorage` makes uploads fail with a Spanish message. Production passes `documentLimits` (size, uploads per day, total bytes) to `storeDocument`.
- **Static assets**: the Vite build in `dist/`, SPA fallback via `not_found_handling: "single-page-application"`, `run_worker_first: true` so every response gets the security headers.
- **Identity**: `session` mode with `Secure` cookies; users and password hashes live in D1, so there are no secrets. Passwords are set from Usuarios (administrator) or with `npm run cf:password -- <usuario>`.
- **AI**: `AI_PROVIDER=disabled` → `DisabledAIProvider`; the assistant shows «La función de IA todavía no está configurada. No se guardó nada.» and the composer shows the same notice. Connecting Workers AI means implementing the placeholders in `server/ai/cloudflare.ts`, adding the `AI` binding and setting `AI_PROVIDER=cloudflare` (see [AI_HANDOFF.md](AI_HANDOFF.md)).
- **Bootstrap**: `server/bootstrap.ts` writes idempotent SQL for the project, login users (by username; the first is the administrator) and units only.

## Known limitations

- Single project and a small team; no roles/permissions beyond the identity boundary.
- Read models load the whole project working set per request (fine for one house; revisit for large datasets).
- Unit conversions are modeled and applied in comparisons, but there is no UI to manage them (seeded for steel bars).
- The mock provider understands common phrasings and simple text PDFs only; photos and scanned PDFs need a real document extractor (Workers AI, pending). HEIC files are stored but not analyzed.
- The Workers AI adapters are placeholders: production AI stays disabled until they are implemented and a binding is added.
- Extracted document text is not cached; re-analyzing a document extracts it again.
- No AI intent for correcting an existing order by chat; corrections use the *Corregir pedido* sheet (audited).
- Deliveries without a known order are supported by the domain command, but neither the HTTP endpoint nor the assistant creates them yet (the assistant asks for the order).
- Computation upload accepts CSV/XLSX (first sheet); PDF computations are not parsed.
- Allocations can be undone from the assistant right after confirming; there is no screen to re-assign old allocations (void + allocate again via API).

## End-to-end scenarios verified

Automated in `tests/` (`npm test`, 67 tests, real SQLite + HTTP app + mock provider), and checked in the browser with Playwright (every screen on desktop and mobile; the assistant, document, correction, delivery, payment and computation-import flows on desktop):

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
| **F** document fixture | extracted text (fixture extractor, photo with no OCR) → classified as remito → delivery proposal for order 38 with remito number and date → nothing written before confirm → delivery + document link after; unclassifiable text → no proposal |
| AI contract | valid output parsed; unknown intents, amounts as text, negative quantities, bad dates, missing fields → `AI_INVALID_RESPONSE`, no pending action stored |
| AI states | `disabled` and `cloudflare` (placeholder) → `AI_NOT_CONFIGURED`; quota → `AI_QUOTA_EXCEEDED`; outage → `AI_PROVIDER_UNAVAILABLE`; the rest of the API keeps serving |
| Matching | «hierro del 12», «acero del 12», «barra Ø12», «acero 12 mm», «Ø12», «barras del 12» → Acero Ø12 (without aliases); «acero» → candidates; unknown supplier → new, not created |
| Queries & context | read-only queries match seed figures and write nothing; «¿Cómo viene el pedido 38?» → «¿Y cuánto falta pagar?» answers $1.482.340; ambiguous follow-up asks «¿De qué pedido?»; «Llegó todo lo pendiente» / «Pagalo completo» use the focused order |
| Login & users | every API route but login/logout needs a session; `juan` signs in by username (e-mails are not usernames); hardened cookie, only the token hash stored; wrong password and unknown user get the same message; logout and 30-day expiry with renewal; 10 failures lock for 15 minutes; only the administrator lists/adds users; a new user can sign in at once; Spanish validation; a person already named in records gets the login; migration 0002 makes the existing owner `juan` and drops e-mails |
| Revalidation | pay-complete proposal refused as stale after a manual payment, refreshed amount confirmed; stale «todo lo pendiente» refreshed; blocked proposal (amount 0) cannot be confirmed; audit metadata `origin: "ai"` + `pendingActionId` |
