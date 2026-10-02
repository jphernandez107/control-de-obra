# Casa Córdoba · Control de Obra

Local full-stack MVP for tracking materials, supplier orders, deliveries, payments, supplier current accounts and the material computation of a residential construction project. The AI assistant conversation is the main entry point; Pedidos, Proveedores, Materiales y cómputo and Actividad are verification views. All user-facing content is in Spanish.

The visual source of truth is the Pen.dev canvas **"Casa Córdoba - Control de Obra"**; the backend was wired underneath the existing UI without redesigning it.

> There is deliberately **no invoice workflow**. Supporting documents are *comprobantes de pedido*, *remitos* and *comprobantes de pago*.

## Run locally

Requires Node 22 (20.19+ / 22.12+).

```bash
npm install
cp .env.example .env      # optional — everything has defaults
npm run db:seed           # creates ./data/casa-cordoba.db with demo data (re-run to reset)
npm run dev               # API on :8787 + web on http://localhost:5173 (Vite proxies /api)
```

Sign in as **`juan`** (administrator) or **`marcelo`**, password **`casacordoba`** (local demo data only).

Locally the assistant uses the deterministic **mock AI provider** (`AI_PROVIDER=mock`), so every flow works offline with no external AI service. Production uses Cloudflare Workers AI on the free allocation; see [AI in production](#ai-in-production-workers-ai).

| Script | What it does |
| --- | --- |
| `npm run dev` | API (`tsx watch server/node.ts`) + Vite dev server |
| `npm run db:seed` | Resets the local database and documents, loads demo data. `npm run db:seed -- --empty` loads only the catalog (no orders, no computation) |
| `npm run db:migrate` | Applies migrations in `drizzle/` |
| `npm run db:generate` | Generates a new migration after editing `server/db/schema.ts` |
| `npm run user:password -- <usuario>` | Sets or resets a user's password in the local database (prompts without echo) |
| `npm test` | End-to-end scenarios and integrity tests (Vitest, real SQLite) |
| `npm run typecheck` / `npm run build` | Type-check frontend + server / production build of the web app |
| `npm run samples` | Regenerates the sample documents in `samples/` |
| `npm run cf:migrate` / `cf:deploy` / `cf:logs` / `cf:bootstrap` / `cf:password` / `cf:fix-units` | Cloudflare production — see [Production](#production-cloudflare) |
| `npm run fix:units -- [--order N] [--apply]` | Correct order lines imported as meters that were bars ("X BARRA 12 MT"); dry run unless `--apply` |
| `npm run cf:dev` | Builds and runs the Worker locally in `workerd` with a local D1/R2 (needs `.dev.vars`, see `.dev.vars.example`) |

### Environment

See [`.env.example`](.env.example). Main variables: `DATABASE_URL` (SQLite file), `DOCUMENTS_DIR` (local document storage), `AI_PROVIDER` (`mock` \| `cloudflare` \| `disabled`; default `mock` locally), `AI_TEXT_MODEL` / `AI_VISION_MODEL` (Workers AI models, production only), `AUTH_MODE` (`session`, the default: login screen \| `dev`: no login, act as `DEV_USERNAME`), `SECURE_COOKIE`, `API_PORT`. Secrets are read only from the environment; `.env` is git-ignored.

### Demo data

`npm run db:seed` replays a realistic history through the real domain commands (so balances, statuses and the audit log come from the same code the app uses). Dates are relative to today. It includes:

- **Hierros Córdoba** with current-account debt ($2.982.340) and a **$500.000 unallocated payment**
- **Pedido 381**: partial delivery (5 barras Ø10 pending) + partial payment
- **Pedido 38**: ordered, nothing delivered or paid (used for the delivery/payment scenarios)
- **Pedido 41**: fully delivered, unpaid · **Pedido 31 / 0027 / 7781**: delivered and fully paid
- **Pedido A-1043**: no supporting document · **Pedido 0035**: unknown value (price to confirm)
- Computation v2 (with a revision of Ø10): Acero Ø12 **exceeds** (111%), Acero Ø10 **approaching** (94%), Caño PVC **reached**, Codo PVC **without computation**
- Stored PDF evidence for most records, and one past conversation

Try in the assistant: «Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba.», «Del pedido 38 llegaron las 20 barras del 12 y 25 barras del 10.», «Se entregó todo lo pendiente del pedido 38.», «Pagamos $500.000 de la cuenta corriente de Hierros Córdoba.», «Pagamos completo el pedido 38.», «¿Cuánto debemos actualmente a Hierros Córdoba?», «¿Qué pedidos siguen pendientes de entrega?», «¿Cuánto acero Ø12 llevamos pedido?», «¿Nos estamos pasando del cómputo?», «¿Cómo viene el pedido 38?» followed by «¿Y cuánto falta pagar?», or attach a file from `samples/`.

## Production (Cloudflare)

One Worker serves the built React app (Static Assets) and the API from one origin: `https://obra.la-calandria.ar/` and `/api/...`. The hostname is a Worker Custom Domain on the owner's existing `la-calandria.ar` zone (Cloudflare Free plan, also used for Home Assistant). The Custom Domain owns only the `obra` DNS record, and its certificate is the zone's free edge certificate. The `workers.dev` address and preview URLs are disabled. Every request (including `index.html`) goes through the Worker first (`run_worker_first`) to get the security headers. The app shell is public and shows the login screen; all data is behind `/api`, which requires a session.

| Piece | Local | Production |
| --- | --- | --- |
| Entry | `server/node.ts` (Hono on Node) | `server/worker.ts` (same Hono app) |
| Database | SQLite file via libsql (`data/casa-cordoba.db`) | D1 `casa-cordoba`, binding `DB` |
| Documents | `LocalFileStorage` (`data/documents/`) | private R2 bucket `casa-cordoba-documents`, binding `DOCUMENTS` (`server/storage/r2.ts`) |
| AI | deterministic mock (`AI_PROVIDER=mock`) | Cloudflare Workers AI (`AI_PROVIDER=cloudflare`, binding `AI`, `server/ai/cloudflare.ts`), Free allocation only. See [AI in production](#ai-in-production-workers-ai) |
| Identity | login screen (username + password), demo users from the seed | the same login screen; users and password hashes in D1 |

Configuration lives in [`wrangler.jsonc`](wrangler.jsonc) (Worker `casa-cordoba`, bindings `DB`, `DOCUMENTS`, `ASSETS`, `AI`, vars `AI_PROVIDER`, `AI_TEXT_MODEL`, `AI_VISION_MODEL`, `AI_MAX_DOCUMENT_MB`, `AI_MAX_MESSAGES_PER_MINUTE`, `MAX_UPLOAD_MB`, `MAX_UPLOADS_PER_DAY`, `MAX_DOCUMENTS_TOTAL_MB`). There are no secrets. Local development never talks to Cloudflare.

### Deploy and operate

```bash
npx wrangler login
npm run cf:migrate                 # applies drizzle/*.sql to the remote D1 (tracked in d1_migrations)
npm run cf:deploy                  # vite build + wrangler deploy
npm run cf:logs                    # live logs (wrangler tail); history in dashboard → Workers → casa-cordoba → Logs (3 days)
```

New schema changes: edit `server/db/schema.ts`, `npm run db:generate`, commit the SQL, then `npm run cf:migrate`. Wrangler and the local migrator both read the same files.

**First-time bootstrap** (already done for this deployment — re-running it is a no-op once a project exists): creates the project, the people who can sign in and the unit table. No demo activity is loaded in production.

```bash
npm run cf:bootstrap -- --project "Casa Córdoba" --user "Nombre|usuario|propietario"   # the first user is the administrator
npx wrangler d1 execute casa-cordoba --remote --file data/bootstrap.sql
npm run cf:password -- usuario
```

**Logins.** People sign in with a **username** and password on the app's login screen (no e-mails). Passwords are stored in D1 as salted PBKDF2-SHA256 hashes (`users.password_hash`). A login opens a session: an `HttpOnly`, `Secure`, `SameSite=Lax` cookie holding a random token, of which D1 stores only the SHA-256 (`sessions`). Sessions last 30 days and are extended while in use. «Cerrar sesión» is in the sidebar and on the Usuarios screen.

- **Adding people:** the administrator (`juan`) opens **Usuarios** and enters name, username, password and role. Nobody else can see or use that screen. Users cannot change their own password.
- **Setting or resetting a password** (also how `juan` gets his first one after migration 0003): `npm run cf:password -- juan` prompts for the password, hashes it on your machine and runs one `wrangler d1 execute` against the remote database. It also signs that user out everywhere.
- **Guessing:** 10 failed attempts for a username lock it for 15 minutes. Use long passwords: anyone with the URL can try to log in.
- PBKDF2 runs 10,000 iterations (~5 ms) to stay inside the Free plan's 10 ms CPU per request. The count is stored in each hash, so it can be raised later.

**Upgrading from the HTTP Basic login** (one time, in this order):

```bash
npm run cf:migrate                 # 0003: adds usernames/sessions, makes the owner `juan` (administrator), drops e-mails
npm run cf:password -- juan        # juan's password for the new login screen
npm run cf:deploy
npx wrangler secret delete APP_USERS   # no longer read
```

Until `cf:password` runs, nobody can sign in. Other people who could sign in before lose access (their passwords lived only in `APP_USERS`); add them again from Usuarios. Someone already named in records (e.g. «pedido por Marcelo») gets the login on that same person, so their history stays linked.

**Purchase units (migration 0004).** An order line keeps what the supplier counts and prices (`172 barras`) and, when the document prints it, the size of one piece (`unit_size_milli`/`unit_size_unit`: 12 m per bar, 50 kg per bag). Equivalents (2.064 m) are derived. Lines imported before 0004 as meters ("HIERRO DIAM.12 X BARRA 12 MT · 172 m") are corrected with a dry-run-first script that only touches lines with that explicit evidence and no deliveries, and writes an audit row. Step-by-step for order #1: [docs/DEPLOY_UNITS_HANDOFF.md](docs/DEPLOY_UNITS_HANDOFF.md).

```bash
npm run cf:migrate                          # 0004: two nullable columns on order_items, no data change
npm run cf:fix-units -- --order 1           # dry run: prints the plan, writes data/fix-purchase-units.sql
npm run cf:fix-units -- --order 1 --apply   # applies it (idempotent); re-run reports nothing to fix
```

**Restore D1 (Time Travel, included in Free, 7 days of history):**

```bash
npx wrangler d1 time-travel info casa-cordoba                               # current bookmark
npx wrangler d1 time-travel restore casa-cordoba --timestamp=<unix-seconds> # overwrites the DB in place; prints a bookmark to undo
npx wrangler d1 export casa-cordoba --remote --output=backup-$(date +%F).sql   # manual off-site copy (keep it private, it contains financial data)
```

Time Travel covers 7 days only; take a periodic `d1 export` to your own machine for anything older. R2 documents are not covered by Time Travel; the app never deletes them.

### Access model

- One login check in the API for every `/api` route except login/logout. No session → `401` (no data). The app shell (HTML/JS/CSS) is public and holds no data.
- The user behind the session is the actor written in the audit log.
- Documents are only reachable through `/api/documents/:id/file` behind the same login. The bucket has no public URL or `r2.dev` access.
- Cloudflare Access (Zero Trust) was evaluated and not used: it needs a payment method registered even for its free plan. It could sit in front of the login screen later. Validate the Access JWT (`ctx.access`) before trusting its identity.

### Guardrails

- Uploads: PDF, JPG, PNG, WEBP, GIF, HEIC, CSV, XLSX only, verified by file signature. **5 MB** per file, **100 uploads per day**, **2 GB total** for the project (`MAX_UPLOAD_MB`, `MAX_UPLOADS_PER_DAY`, `MAX_DOCUMENTS_TOTAL_MB`). JSON bodies are capped at 1 MB.
- Object keys are generated (`<project>/<yyyy-mm>/<uuid>-<sanitized name>`) and validated against traversal.
- Errors return a generic Spanish message. Details only go to the Worker logs.
- Security headers on every response: HSTS, CSP (`'self'` only), `nosniff`, `SAMEORIGIN` framing, same-origin referrer.

### AI in production (Workers AI)

The assistant calls Workers AI through the `AI` binding, server-side only. The browser never sees a key or a model response.

| Use | Model (`wrangler.jsonc` var) | How |
| --- | --- | --- |
| Messages: classify and extract | `@cf/zai-org/glm-4.7-flash` (`AI_TEXT_MODEL`) | Tool calling: one tool per intent (`propose_create_order`, `propose_register_delivery`, `propose_complete_order_delivery`, `propose_supplier_payment`, `propose_order_payment`, `ask_project_question`, `request_clarification`, …). A tool call is only a proposal. It is validated by the app's Zod schemas, then shown as a card, and nothing is written until the user confirms |
| PDFs | `env.AI.toMarkdown` | Free conversion. Scanned PDFs without a text layer come back empty, and the assistant asks for a photo |
| Photos (JPG/PNG/WEBP/GIF) | `@cf/google/gemma-4-26b-a4b-it` (`AI_VISION_MODEL`) | One transcription call (text only, no interpretation), then the same text model as above |

- **One model call per message** (two for a photo). No retries, no agent loops, reasoning turned off. Figures (balances, remaining quantities, amounts to pay) always come from D1, never from the model.
- **Each document is read once.** The text is stored in `document_extractions`, keyed by the file's SHA-256, so re-sending the same file costs nothing.
- **Limits:** AI document reading up to `AI_MAX_DOCUMENT_MB` (4 MB). Extracted text is capped at 12,000 characters. The chat context is the last 6 turns (280 characters each). The cap is `AI_MAX_MESSAGES_PER_MINUTE` (8) messages per user per minute, and the same message sent twice within 20 s is refused.
- **Errors** are mapped in the adapter to the app's codes: quota, model unavailable, temporarily saturated, provider down, invalid response, unreadable or unsupported document. The user sees a Spanish message and nothing is saved.
- **Prompts** are in `server/ai/prompts.ts`. `PROMPT_VERSION` is logged with every call.
- **Change a model:** edit `AI_TEXT_MODEL` / `AI_VISION_MODEL` in `wrangler.jsonc` and run `npm run cf:deploy`. Only use models whose page has no "Workers Paid" requirement: Cloudflare marks those with `require_workers_paid` and refuses them on this plan. To turn AI off, set `AI_PROVIDER` to `disabled`.
- **Usage:** dashboard → AI → Workers AI (neurons per day and per model). Each call is also logged with model, time and tokens (`npm run cf:logs`, or Workers → `casa-cordoba` → Logs).

## Cost / Free Tier

Verified against the official Cloudflare documentation on **2026-10-02**. The account stays on **Workers Free**; nothing was upgraded.

| Product | Free allowance | When exceeded | Can it bill? |
| --- | --- | --- | --- |
| Workers (Free) | 100,000 requests/day, 10 ms CPU per request, 50 subrequests | Error 1027 / 429 until 00:00 UTC | **No.** Hard limit on the Free plan |
| Static Assets | Unlimited, free. Here every asset request also runs the Worker (security headers), so it counts toward the 100k/day | — | No |
| D1 (Free) | 5M rows read/day, 100k rows written/day, 500 MB per DB, 5 GB per account, 50 queries per request, Time Travel 7 days | Queries fail until 00:00 UTC | **No.** Hard limit |
| Workers Logs | 200,000 events/day, 3-day retention | Sampled at 1% | No |
| Custom Domain + certificate | Free on any plan for a zone already on Cloudflare (first-level subdomain, covered by the free Universal SSL certificate) | — | No |
| Workers AI | 10,000 neurons/day, shared by all models. Measured here: about 30 neurons per message (GLM-4.7-Flash, ~4,600 input tokens) and about 5 per photo transcription (Gemma 4), so roughly 300 messages/day. PDF conversion is free | Calls fail with error 3036 until **00:00 UTC (21:00 in Córdoba)**. The assistant shows «La cuota gratuita de IA de hoy se agotó…» and the rest of the app keeps working | **No.** On Workers Free, usage above the allocation is refused, never billed. Only Workers Paid bills neurons ($0.011/1,000) |
| **R2** (Standard) | 10 GB-month storage, 1M Class A (writes/lists), 10M Class B (reads) per month, egress free | **Billed automatically** ($0.015/GB-month, $4.50/M Class A, $0.36/M Class B) | **Yes.** R2 needs a payment method and has **no hard spending cap** |

**R2 is the only usage-billed product in this deployment.** Safeguards:

- The bucket is private (no public bucket URL, no `r2.dev`). Only logged-in users can upload or read.
- Application caps keep usage far below the free tier, even with a leaked password. 100 uploads/day ≈ 3,000 Class A ops/month, against 1M free. Total documents are capped at 2 GB, against 10 GB free. Reads happen only when someone opens a document, and are cached in the browser for 1 hour.
- A **$1 budget alert** (Billing → Billable Usage) emails the owner on any usage-based spend. It is informational only: Cloudflare offers no hard cap for R2.
- Not used: Workers Paid, AI Gateway, paid-only Workers AI models, external AI APIs (Anthropic, OpenAI, Gemini), KV, Queues, Durable Objects, Zero Trust, Logpush, Analytics Engine.

**What to watch in the dashboard:** Billing → Billable Usage (should stay $0.00), AI → Workers AI (neurons/day vs 10,000), R2 → `casa-cordoba-documents` → Metrics (storage and operations), Workers & Pages → `casa-cordoba` → Metrics (requests/day vs 100k), D1 → `casa-cordoba` → Metrics (rows read/written).

**Known free-tier pressure points.** None of these can create charges. They can make requests fail until the daily reset.

- D1 rows read: each screen reads the whole project working set. A very large project (thousands of rows), viewed hundreds of times a day, could approach 5M rows/day.
- The conversations drawer runs one query per conversation (up to 50). It may hit the 50-queries-per-request limit once there are ~45+ conversations.
- 10 ms CPU per request: fine for the current data volume. Large XLSX imports are the heaviest operation; a login (PBKDF2) takes about 5 ms.

Docs used: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) · [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) · [Workers + Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) · [Zero Trust setup](https://developers.cloudflare.com/cloudflare-one/setup/) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/) · [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/) · [Markdown conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) · [GLM-4.7-Flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/) · [Gemma 4 26B](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)

## Stack

- **Web**: React 19 · TypeScript · Vite · TanStack Router/Query · Tailwind CSS v4 (unchanged UI)
- **API**: Hono (runs on Node via `@hono/node-server`, and on Cloudflare Workers unchanged)
- **Data**: Drizzle ORM · SQLite (libsql locally) · migrations in `drizzle/` (D1-compatible SQL)
- **AI**: provider-independent interface (`AIProvider`, `DocumentContentExtractor`), validated intents (Zod), deterministic `MockAIProvider`, Cloudflare Workers AI adapter (`server/ai/cloudflare.ts`)
- **Tests**: Vitest, end-to-end through the HTTP app against a real SQLite file

Architecture, domain rules and the Cloudflare migration path are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Structure

```
server/
  db/             schema.ts (relational model), client.ts (AppDb type), node.ts (libsql adapter + migrations)
  domain/         pure rules: money (minor units), quantities (thousandths), matching, derivations (Ledger), errors
  repositories/   snapshot loader (project working set, D1-safe queries)
  services/       commands (validated writes + audit), queries (read models), assistant (conversations,
                  proposals lifecycle), documents, computation import (CSV/XLSX)
  ai/             provider + extractor interfaces, intent schemas, errors, factory, mock, cloudflare (placeholder),
                  prompts, resolve (matching), proposals, pending actions, project queries (read-only),
                  conversation context,
                  answers (deterministic read queries), review (revise/confirm)
  storage/        DocumentStorage interface, LocalFileStorage (Node), MemoryStorage (tests)
  http/           Hono app (transport only) and identity boundary (passwords, sessions)
  node.ts         local server entry · seed.ts · migrate.ts · dev/ (catalog, PDF writer, samples)
src/
  domain/         API contract types shared with the server, formatters
  services/api/   HTTP implementation of the Services interfaces used by every screen
  …               pages, components and assistant feature (UI from the design)
drizzle/          SQL migrations
samples/          sample documents for trying document interpretation
tests/            scenarios A–H, integrity rules, AI architecture (contract, errors, matching, queries, context, revalidation, Scenario F)
```

## What changed in the UI

The screens, layouts and components are the ones from the design. Functional adjustments only:

- Mock services removed; every screen reads/writes the API. Loading and error states are real.
- Proposal cards show match quality (weak match → *Verificar*, *Material nuevo*), stated totals, "Sin número"/"Sin indicar" for missing fields; edits of supplier/material/order are re-resolved by the server.
- Item editor uses the real catalog and units, decimal quantities, and lets the user resolve weak material matches explicitly.
- Payment card supports split payments and shows any amount that stays unallocated; attaching a receipt uploads it.
- Order detail: a *Corregir pedido* sheet (number, date, prices, quantities, stated total, reason), notes persisted, direct document attach, real units.
- Computation upload shows a review sheet (CSV/XLSX) before saving; computation adjustments accept decimals and a reason.
- Document preview shows the stored image/PDF and downloads it; CSV export on list pages.
- Conversations drawer opens past conversations and starts a new one. The `?demo=` switches of the mock were removed (use `npm run db:seed -- --empty` for an empty project).
