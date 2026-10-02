# Casa Córdoba · Control de Obra

Frontend for tracking materials, supplier orders, deliveries, payments and supplier current accounts for a residential construction project. The AI assistant conversation is the main entry point; Pedidos, Proveedores, Materiales y cómputo and Actividad are verification views.

The visual source of truth is the Pen.dev canvas **"Casa Córdoba - Control de Obra"**. Layout, tokens (colors, Geist / Geist Mono, radii) and component patterns follow it; desktop and mobile layouts are implemented separately at the `lg` (1024 px) breakpoint.

## Run locally

Requires Node 20.19+ or 22.12+.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
npm run preview    # serve the production build
```

## Stack

React 19 · TypeScript · Vite · TanStack Router (code-based routes in `src/app/router.tsx`) · TanStack Query · Tailwind CSS v4 (tokens in `src/styles/index.css`, light and dark themes) · lucide-react.

## Structure

```
src/
  domain/          Frontend-facing types (orders, suppliers, materials, activity, assistant) and formatters
  services/
    types.ts       Data-access interfaces (OrdersService, SuppliersService, MaterialsService,
                   ActivityService, DashboardService, AssistantService)
    index.tsx      ServicesProvider — swap the mock for a real implementation here
    mock/          In-memory implementation: seed data, derived statuses/balances, deterministic assistant
  queries/         TanStack Query hooks used by pages
  components/      Visual components (ui primitives, layout, domain widgets, sheets)
  features/assistant/  Conversation state, composer, interpretation cards
  pages/           Route components
```

Pages only talk to the `Services` interfaces through `src/queries` and `AssistantProvider`, so replacing `createMockServices()` with an API-backed implementation should not require touching visual components.

## What is mocked

Everything data-related runs locally in the browser and resets on reload:

- **Data**: suppliers, orders, deliveries, payments, documents, computation and activity live in `src/services/mock/db.ts`. Statuses, balances and computation comparisons are derived in `src/services/mock/derive.ts`.
- **Assistant**: `src/services/mock/assistant.ts` recognises a few phrasings with regular expressions (e.g. “Marcelo pidió 20 barras del 12 y 30 del 10 a Hierros Córdoba.”, “Llegaron las 20 barras del 12.”, “Pagamos 400 mil a la ladrillera”, “¿Cuánto debemos a Hierros Córdoba?”, “¿Qué pedidos siguen pendientes de entrega?”). Attachments are classified by file name (`remito`, `pago`/`transfer`, `borrosa` triggers the read-error state).
- **Confirm / undo** mutate the in-memory store, so new orders, deliveries and payments show up across all views.
- **Documents** show a placeholder preview; downloads and exports show a notice.

### Demo states

Append `?demo=` to any URL (kept for the browser session, combinable with commas):

| Value | Shows |
| --- | --- |
| `nuevo` | Empty project (first-order flow, empty states) |
| `sin-computo` | Project without a loaded computation |
| `cargando` | List screens stuck in their loading skeletons |
| `error` | List screens fail once; “Reintentar” recovers |
| `reset` | Back to the default scenario |

## Intentionally deferred

No backend, database, authentication, document storage, real AI calls or deployment are included. Those integrations belong behind the interfaces in `src/services/types.ts`.
