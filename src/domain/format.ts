import type { ISODate, ISODateTime, PaymentMethod, PurchaseMode } from "./types";

const moneyFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const numberFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });

/** `$1.482.340` — Argentine thousands separator, no currency code. */
export function formatMoney(value: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(value);
  const formatted = `$${moneyFormatter.format(abs)}`;
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

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[A-ZÁÉÍÓÚ]/.test(w))
    .filter((w) => !["del", "de", "la", "las", "los", "El"].includes(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
