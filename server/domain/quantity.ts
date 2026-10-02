// Quantities are stored as integer thousandths ("milli") so sums and
// comparisons are exact: 6,5 m³ → 6500.

export const QTY_SCALE = 1000;

export function toMilli(value: number | string): number | null {
  const text = typeof value === "number" ? (Number.isFinite(value) ? value.toFixed(6) : "") : value.trim().replace(/\s/g, "");
  if (!text) return null;
  let normalized = text;
  if (normalized.includes(",")) normalized = normalized.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) normalized = normalized.replace(/\./g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(4, "0");
  let milli = Number(m[1]) * QTY_SCALE + Number(frac.slice(0, 3));
  if (Number(frac[3]) >= 5) milli += 1;
  return Number.isSafeInteger(milli) ? milli : null;
}

/** Thousandths → display number (6500 → 6.5). Only for presentation/transport. */
export function fromMilli(milli: number): number {
  return milli / QTY_SCALE;
}

/** Applies a rational conversion factor (from → to) to a milli quantity. */
export function convertMilli(milli: number, factorNum: number, factorDen: number): number {
  return Number((BigInt(milli) * BigInt(factorNum) + BigInt(Math.floor(factorDen / 2))) / BigInt(factorDen));
}
