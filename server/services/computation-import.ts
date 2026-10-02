import { DomainError } from "../domain/errors";
import type { Ledger } from "../domain/derive";
import { matchMaterial, type MatchStatus } from "../domain/matching";
import { fromMilli, toMilli } from "../domain/quantity";
import { normalizeText } from "../domain/text";
import { unitCodeFromWord } from "../domain/units";
import { materialCandidates } from "../ai/proposals";
import { parseCsv, parseXlsx } from "./spreadsheet";

// Computation spreadsheet → reviewed rows. The preview never writes; the
// user confirms the matches (existing material vs. new) before saving.

export interface ComputationPreviewRow {
  line: number;
  name: string;
  unit: string;
  unitCode: string | null;
  expected: number;
  stage: string | null;
  wastePct: number;
  materialId: string | null;
  materialName: string | null;
  match: MatchStatus;
  candidates: { id: string; name: string; unit: string }[];
  /** Ordered so far, to show the effect immediately (historical orders need no reassignment). */
  ordered: number | null;
  problem: string | null;
}

const HEADERS: Record<string, RegExp> = {
  name: /^(material|materiales|descripcion|item|insumo|detalle)$/,
  unit: /^(unidad|unid|un|u|um)$/,
  expected: /^(cantidad|cant|previsto|prevista|computo|total|cantidad prevista)$/,
  stage: /^(etapa|rubro|categoria|capitulo)$/,
  waste: /^(desperdicio|desp|% desperdicio|perdida)$/,
};

export async function readComputationSheet(fileName: string, mimeType: string, data: Uint8Array): Promise<string[][]> {
  if (mimeType.includes("spreadsheet") || fileName.toLowerCase().endsWith(".xlsx")) return parseXlsx(data);
  if (mimeType === "text/csv" || /\.(csv|txt)$/i.test(fileName)) return parseCsv(data);
  throw new DomainError("unsupported_document", "Sube el cómputo como planilla .xlsx o .csv (una fila por material: material, unidad, cantidad).");
}

export function previewComputation(ledger: Ledger, rows: string[][]): ComputationPreviewRow[] {
  if (!rows.length) throw new DomainError("validation", "La planilla está vacía.");
  const header = rows[0]!.map((h) => normalizeText(h));
  const col: Record<string, number> = {};
  for (const [key, re] of Object.entries(HEADERS)) {
    const idx = header.findIndex((h) => re.test(h));
    if (idx >= 0) col[key] = idx;
  }
  const hasHeader = col.name !== undefined && col.expected !== undefined;
  const body = hasHeader ? rows.slice(1) : rows;
  const c = hasHeader ? col : { name: 0, unit: 1, expected: 2 };
  const catalog = materialCandidates(ledger);
  const out: ComputationPreviewRow[] = [];
  body.forEach((r, i) => {
    const name = (r[c.name!] ?? "").trim();
    if (!name) return;
    const rawQty = (r[c.expected!] ?? "").trim();
    const milli = rawQty ? toMilli(rawQty) : null;
    const unitWord = c.unit !== undefined ? (r[c.unit] ?? "").trim() : "";
    const match = matchMaterial(name, catalog);
    const material = match.status === "matched" ? match.best : undefined;
    const unitCode = unitCodeFromWord(unitWord, ledger.s.units) ?? (material ? material.baseUnit : null);
    const wasteRaw = c.waste !== undefined ? (r[c.waste] ?? "").replace("%", "").trim() : "";
    const waste = wasteRaw ? Number(wasteRaw.replace(",", ".")) : 0;
    let problem: string | null = null;
    if (milli === null || milli <= 0) problem = "Cantidad inválida";
    else if (!unitCode) problem = `Unidad «${unitWord}» desconocida`;
    else if (material && unitCode !== material.baseUnit && ledger.inBaseUnit(material.id, 1000, unitCode) === null) problem = `Unidad distinta a la del material (${ledger.unitLabel(material.baseUnit)}) sin conversión definida`;
    out.push({
      line: i + (hasHeader ? 2 : 1),
      name,
      unit: unitWord || (unitCode ? ledger.unitLabel(unitCode) : ""),
      unitCode,
      expected: milli === null ? 0 : fromMilli(milli),
      stage: c.stage !== undefined ? (r[c.stage] ?? "").trim() || null : null,
      wastePct: Number.isFinite(waste) && waste >= 0 ? waste : 0,
      materialId: match.status === "new" ? null : match.best!.id,
      materialName: match.status === "new" ? null : match.best!.name,
      match: match.status,
      candidates: match.candidates.map((x) => ({ id: x.item.id, name: x.item.name, unit: ledger.unitLabel(x.item.baseUnit) })),
      ordered: match.status === "new" ? null : fromMilli(ledger.materialTotals(match.best!.id).orderedMilli),
      problem,
    });
  });
  if (!out.length) throw new DomainError("validation", "No encontré filas con material y cantidad. Usa columnas: material, unidad, cantidad.");
  return out;
}
