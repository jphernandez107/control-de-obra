import type { DeliveryProgress, ISODate, ISODateTime, PaymentMethod, PurchaseMode } from "./types";

const moneyFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const numberFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 });

/**
 * `$1.482.340` — Argentine thousands separator, no currency code.
 * Takes integer minor units (centavos); the division happens only here, for display.
 */
export function formatMoney(minor: number, opts: { sign?: boolean } = {}): string {
  const value = Math.round(minor);
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 100);
  const cents = abs % 100;
  const formatted = `$${moneyFormatter.format(whole)}${cents ? `,${String(cents).padStart(2, "0")}` : ""}`;
  if (value < 0) return `-${formatted}`;
  if (opts.sign && value > 0) return `+${formatted}`;
  return formatted;
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function parts(date: ISODate | ISODateTime) {
  const [y, m, d] = date.slice(0, 10).split("-");
  return { y, m, d };
}

/** `02/10/2026` */
export function formatDate(date: ISODate | ISODateTime): string {
  const { y, m, d } = parts(date);
  return `${d}/${m}/${y}`;
}

/** `02/10` */
export function formatShortDate(date: ISODate | ISODateTime): string {
  const { m, d } = parts(date);
  return `${d}/${m}`;
}

export function formatTime(date: ISODateTime): string {
  return date.slice(11, 16);
}

const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const WEEKDAYS_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function toDate(date: ISODate | ISODateTime): Date {
  const { y, m, d } = parts(date);
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

/** "Hoy", "Ayer" or the weekday name, relative to `today`. */
export function relativeDayLabel(date: ISODate, today: ISODate): string {
  const diff = daysBetween(date, today);
  if (diff === 0) return "Hoy";
  if (diff === 1) return "Ayer";
  return WEEKDAYS[toDate(date).getDay()];
}

/** `vie 16/10` */
export function formatWeekdayShort(date: ISODate): string {
  return `${WEEKDAYS_SHORT[toDate(date).getDay()]} ${formatShortDate(date)}`;
}

/** "10:24" today, "Ayer", otherwise `13/10`. */
export function formatRelativeStamp(at: ISODateTime, today: ISODate): string {
  const diff = daysBetween(at.slice(0, 10), today);
  if (diff === 0) return formatTime(at);
  if (diff === 1) return "Ayer";
  return formatShortDate(at);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

export const paymentMethodLabel: Record<PaymentMethod, string> = {
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  cheque: "Cheque",
  otro: "Otro",
};

export const purchaseModeLabel: Record<PurchaseMode, string> = {
  cuenta_corriente: "Cuenta corriente",
  contado: "Contado",
};

/** Unit labels that read better with a space and the plural form. */
export function formatQuantity(value: number, unit: string): string {
  return `${formatNumber(value)} ${unit}`;
}

/**
 * "20 de 60 barras" when every line shares a unit; otherwise counts materials
 * ("0 de 5 materiales"), because bars and kilograms cannot be added.
 */
export function deliveryAmountLabel(d: DeliveryProgress): string {
  if (d.sameUnit) return `${formatNumber(d.sameUnit.delivered)} de ${formatNumber(d.sameUnit.ordered)} ${d.sameUnit.unit}`;
  return `${formatNumber(d.completeLines)} de ${pluralize(d.lines, "material", "materiales")}`;
}

/** "172 barras · 12 m c/u" (+ equivalent when asked). */
export function purchaseSizeLabel(line: { unitSize?: { quantity: number; unit: string }; equivalent?: { quantity: number; unit: string } }, withEquivalent = true): string | undefined {
  if (!line.unitSize) return undefined;
  const size = `${formatNumber(line.unitSize.quantity)} ${line.unitSize.unit} c/u`;
  return withEquivalent && line.equivalent ? `${size} · ${formatNumber(line.equivalent.quantity)} ${line.equivalent.unit}` : size;
}

/**
 * Parses what a user types in a money field ("$12.400", "1712,50", "500000")
 * into minor units without floating point. Returns null when empty/invalid.
 */
export function parseMoneyInput(raw: string): number | null {
  let text = raw.trim().replace(/[^\d.,]/g, "");
  if (!text) return null;
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  const m = /^(\d+)(?:\.(\d{0,2})\d*)?$/.exec(text);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[A-ZÁÉÍÓÚ]/.test(w))
    .filter((w) => !["del", "de", "la", "las", "los", "El"].includes(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
