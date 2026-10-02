// Money is handled as integer minor units (centavos) end to end. These
// helpers convert user/AI text into minor units without floating point.

const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

/** Splits a decimal string ("1712.5") into integer minor units, or null. */
function decimalStringToMinor(value: string, scale = 2): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, "");
  let frac = (m[2] ?? "").padEnd(scale + 1, "0");
  // Round half up on the first dropped digit.
  const roundUp = Number(frac[scale]) >= 5;
  frac = frac.slice(0, scale);
  let result = Number(whole) * 10 ** scale + Number(frac || "0");
  if (roundUp) result += 1;
  return Number.isSafeInteger(result) && result <= MAX_SAFE_MINOR ? result : null;
}

/**
 * Parses an Argentine-style amount into minor units.
 * Accepts "$1.482.340", "1.482.340,50", "500000", "500000.00", "400 mil",
 * "1,5 millones" and plain numbers coming from validated JSON.
 */
export function parseMoneyToMinor(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    // Numbers from JSON are formatted back to text and parsed as decimals.
    return decimalStringToMinor(input.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
  }
  let text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  let multiplier = 1;
  if (/(millones|millon|millón|palos?)\b/.test(text)) multiplier = 1_000_000;
  else if (/\b(mil|lucas?|k)\b/.test(text)) multiplier = 1_000;
  text = text.replace(/[^\d.,]/g, "");
  if (!text) return null;
  let normalized: string;
  if (text.includes(",")) {
    // es-AR: dots group thousands, comma is the decimal separator.
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    normalized = text.replace(/\./g, "");
  } else {
    normalized = text;
  }
  if ((normalized.match(/\./g) ?? []).length > 1) return null;
  const minor = decimalStringToMinor(normalized);
  if (minor === null) return null;
  const result = minor * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

/** unit price (minor) × quantity (thousandths) → line total (minor), rounded half up. */
export function lineTotalMinor(unitPriceMinor: number, quantityMilli: number): number {
  const product = BigInt(unitPriceMinor) * BigInt(quantityMilli);
  return Number((product + 500n) / 1000n);
}

export function sumMinor(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}
