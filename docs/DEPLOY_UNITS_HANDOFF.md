# Handoff: purchase units and material questions (migration 0004)

For the agent with Cloudflare access. The application change is complete, tested and on `main`.
Nothing has been deployed and production data has not been touched.

## The issue in production

Order **#1** (Hierros Córdoba) was imported from the supplier's document:

| Printed line | Meaning | Stored by the first import |
| --- | --- | --- |
| `753 · HIERRO DIAM.6 X BARRA 12 MT · $4.875` | 753 bars Ø6, 12 m each | 753 **m** |
| `113 · HIERRO DIAM.8 X BARRA 12 MT · $8.440` | 113 bars Ø8 | 113 **m** |
| `263 · HIERRO DIAM.10 X BARRA 12 MT · $13.183` | 263 bars Ø10 | 263 **m** |
| `172 · HIERRO DIAM.12 X BARRA 12 MT · $18.844` | 172 bars Ø12 (= 2.064 m) | 172 **m** |
| `100 · ALAMBRE … · KG · $3.260` | 100 kg of wire | 100 kg (correct) |

Only the **unit** of the four steel lines is wrong. Quantities, unit prices, line totals and the
order total ($11.658.892) are right, because they already counted bars. The order screen also
showed "0 de 1.401 u", which added bars and kilograms together. That is a code bug and is fixed
by the deploy alone.

## What changed (code)

- **Schema:** `order_items.unit_size_milli` + `order_items.unit_size_unit`. They hold the size of one purchase
  unit ("X BARRA 12 MT" → 12000 + `m`). Both are nullable, and no existing row changes.
  Equivalent quantities (172 barras → 2.064 m) are derived, never stored.
- **Imports:** the application reads the purchase format from the printed description for every provider. A
  unit equal to the piece's size unit ("172 m" for "X BARRA 12 MT") becomes `barra`, with a 12 m size, and the
  review card says so. New steel is named canonically (`Acero Ø12`). The printed wording is saved as an alias,
  and the catalog learns `1 barra = 12 m`.
- **Summaries:** order delivery progress is computed per line. Mixed units show "0 de 5 materiales", never one
  total.
- **Questions:** material questions are answered by the application from persisted order lines, deliveries
  and the computation, never from the PDF. Metrics: pedido, llegado, falta que llegue, cómputo, falta pedir,
  importe, precio unitario, historial. Follow-ups keep the material. Vague questions are asked back.
- **No new environment variables, bindings or secrets.** `wrangler.jsonc` is unchanged.

## Steps

```bash
git pull origin main
npm ci
npm test                                   # 119 tests, all must pass
npx wrangler login

npm run cf:migrate                         # applies 0004_purchase_unit_size (2 × ALTER TABLE ADD COLUMN, no data change)
npm run cf:deploy

# Order #1 correction: dry run first. It prints the plan and writes data/fix-purchase-units.sql; it writes nothing to D1.
npm run cf:fix-units -- --order 1
# Review the output (expected below), then apply:
npm run cf:fix-units -- --order 1 --apply
# Re-running must report: "No hay líneas para corregir en casa-cordoba (producción) (pedido 1)."
npm run cf:fix-units -- --order 1
```

Order matters only in one way: run `cf:migrate` before the fix, which needs the new columns. Deploying before
the fix is safe. Until the fix runs, order #1 shows its lines as "172 m".

### Expected dry-run output

The names may differ if someone edited them in production:

```
Líneas a corregir en casa-cordoba (producción):
  · pedido #1 «HIERRO DIAM.6 X BARRA 12 MT»: 753 m → 753 barras de 12 m
  · pedido #1 «HIERRO DIAM.8 X BARRA 12 MT»: 113 m → 113 barras de 12 m
  · pedido #1 «HIERRO DIAM.10 X BARRA 12 MT»: 263 m → 263 barras de 12 m
  · pedido #1 «HIERRO DIAM.12 X BARRA 12 MT»: 172 m → 172 barras de 12 m
  · material HIERRO DIAM.12 X BARRA 12 MT (m) → Acero Ø12 (barra) (1 barra = 12 m)
  …
```

**Stop and report instead of applying** if any of these happen:

- The plan lists the wire line, or any line whose description does not print "BARRA <n> MT".
- It lists lines from orders other than #1 (the `--order 1` filter should prevent this).
- It reports `omitida … tiene entregas registradas en esa unidad`. A delivery was recorded in meters against a
  bar line, and that needs a person to decide what arrived.
- It reports `ya existe «Acero Ø12»`. Two materials would need merging, which is not automatic.

### What the fix does, and why it is safe

`server/services/unit-fix.ts` changes a line only when there is explicit evidence:

- Its description, or its material's name or alias, prints a piece format ("X BARRA 12 MT").
- The stored unit is that piece's size unit (`m`).
- No delivery was recorded against the line.

It does **not** turn every `m` line into bars. For each corrected line it:

1. Sets `unit = 'barra'`, `unit_size_milli = 12000`, `unit_size_unit = 'm'`. Quantity, unit price and line total stay as they are.
2. Changes the material's `base_unit` from `m` to `barra` (only if it has no other records in meters), adds a
   `unit_conversions` row (1 barra = 12 m), and renames it to the canonical `Acero Ø<d>`. The printed name stays
   as an alias.
3. Adds one `audit_log` row per order (`order.corrected`, source `system`, before/after per line), which
   shows as «Registro corregido» in the order history.

Every statement is guarded (`WHERE unit = 'm' AND unit_size_milli IS NULL`, `WHERE NOT EXISTS …`), so a second
run changes nothing. Rollback: D1 Time Travel (`npx wrangler d1 time-travel restore casa-cordoba --timestamp=…`;
take `time-travel info` before applying).

## Verify after deployment

Signed in as `juan`, in a new conversation in the assistant:

| Ask | Expected (from structured data) |
| --- | --- |
| ¿Cuántas barras del 12 se pidieron? | Se pidieron 172 barras de Acero Ø12 de 12 m cada una. Equivalen a 2.064 m lineales. |
| ¿y cuántas llegaron? | Todavía no llegó ninguna barra de Acero Ø12. Hay 172 barras pendientes de entrega. |
| ¿Cuántas barras del 10 se pidieron? | Se pidieron 263 barras de Acero Ø10 … |
| ¿Cuántos kilos de alambre se pidieron? | Se pidieron 100 kg de … |
| ¿Cuántos metros lineales de hierro Ø12 se pidieron? | Se pidieron 2.064 m lineales de Acero Ø12 (172 barras de 12 m cada una). |
| ¿Cuánto salió el hierro del 12? | Acero Ø12 salió $3.241.168: 172 barras a $18.844 cada una … |
| ¿Cuánto costó cada barra del 12? | Cada barra de Acero Ø12 costó $18.844 … |

These answers do not depend on the Workers AI model's wording: the model only classifies, and the application
renders the figures. Questions do not re-read the PDF (`npm run cf:logs` shows no `toMarkdown` calls for them).

On **Pedidos → #1**:

- The Entrega card says **"0 de 5 materiales"**, not "0 de 1.401 u".
- Each steel line says e.g. **"172 barras"** with "12 m c/u · 2.064 m" under the name.
- The total is still **$11.658.892**, and the history shows «Registro corregido».

On **Materiales**: Acero Ø6/Ø8/Ø10/Ø12 in barras, the wire in kg.

## If the fix cannot be applied automatically

Correct the lines by hand with the same statements the script prints (they are in
`data/fix-purchase-units.sql` after a dry run). For a line with deliveries recorded in meters, decide first
whether those deliveries counted bars (then change the delivery line's unit to `barra` too) or meters (then
convert with ÷ 12). Do not guess.
