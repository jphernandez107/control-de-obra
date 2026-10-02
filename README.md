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

Without `ANTHROPIC_API_KEY` the app uses the deterministic **mock AI provider**, so every flow works offline. Set `ANTHROPIC_API_KEY` (and optionally `AI_PROVIDER=anthropic`) to use Claude.

| Script | What it does |
| --- | --- |
| `npm run dev` | API (`tsx watch server/node.ts`) + Vite dev server |
| `npm run db:seed` | Resets the local database and documents, loads demo data. `npm run db:seed -- --empty` loads only the catalog (no orders, no computation) |
| `npm run db:migrate` | Applies migrations in `drizzle/` |
| `npm run db:generate` | Generates a new migration after editing `server/db/schema.ts` |
| `npm test` | End-to-end scenarios and integrity tests (Vitest, real SQLite) |
| `npm run typecheck` / `npm run build` | Type-check frontend + server / production build of the web app |
| `npm run samples` | Regenerates the sample documents in `samples/` |

### Environment

See [`.env.example`](.env.example). Main variables: `DATABASE_URL` (SQLite file), `DOCUMENTS_DIR` (local document storage), `AI_PROVIDER` (`auto` \| `mock` \| `anthropic`), `ANTHROPIC_API_KEY`, `AI_MODEL` (default `claude-opus-5-5`), `AI_EFFORT`, `AUTH_MODE` (`dev` \| `cloudflare-access`), `DEV_USER_EMAIL`, `API_PORT`. Secrets are read only from the environment; `.env` is git-ignored.

### Demo data

`npm run db:seed` replays a realistic history through the real domain commands (so balances, statuses and the audit log come from the same code the app uses). Dates are relative to today. It includes:

- **Hierros Córdoba** with current-account debt ($2.982.340) and a **$500.000 unallocated payment**
- **Pedido 381**: partial delivery (5 barras Ø10 pending) + partial payment
- **Pedido 38**: ordered, nothing delivered or paid (used for the delivery/payment scenarios)
- **Pedido 41**: fully delivered, unpaid · **Pedido 31 / 0027 / 7781**: delivered and fully paid
- **Pedido A-1043**: no supporting document · **Pedido 0035**: unknown value (price to confirm)
- Computation v2 (with a revision of Ø10): Acero Ø12 **exceeds** (111%), Acero Ø10 **approaching** (94%), Caño PVC **reached**, Codo PVC **without computation**
- Stored PDF evidence for most records, and one past conversation

Try in the assistant: «Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba.», «Del pedido 38 llegaron las 20 barras del 12 y 25 barras del 10.», «Se entregó todo lo pendiente del pedido 38.», «Pagamos $500.000 de la cuenta corriente de Hierros Córdoba.», «Pagamos completo el pedido 38.», «¿Cuánto debemos actualmente a Hierros Córdoba?», «¿Qué pedidos siguen pendientes de entrega?», «¿Cuánto acero Ø12 llevamos pedido?», «¿Nos estamos pasando del cómputo?», or attach a file from `samples/`.

## Stack

- **Web**: React 19 · TypeScript · Vite · TanStack Router/Query · Tailwind CSS v4 (unchanged UI)
- **API**: Hono (runs on Node via `@hono/node-server`, and on Cloudflare Workers unchanged)
- **Data**: Drizzle ORM · SQLite (libsql locally) · migrations in `drizzle/` (D1-compatible SQL)
- **AI**: provider interface with `MockAIProvider` and `AnthropicAIProvider` (`@anthropic-ai/sdk`, structured outputs validated with Zod)
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
  ai/             provider interface + schemas, mock, anthropic, proposals (matching → proposals),
                  answers (deterministic read queries), review (revise/confirm)
  storage/        DocumentStorage interface, LocalFileStorage (Node), MemoryStorage (tests)
  http/           Hono app (transport only) and identity boundary
  node.ts         local server entry · seed.ts · migrate.ts · dev/ (catalog, PDF writer, samples)
src/
  domain/         API contract types shared with the server, formatters
  services/api/   HTTP implementation of the Services interfaces used by every screen
  …               pages, components and assistant feature (UI from the design)
drizzle/          SQL migrations
samples/          sample documents for trying document interpretation
tests/            scenarios A–H, integrity rules, Anthropic adapter
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
