// Calendar helpers that work in Node and Workers (Intl only, no Node APIs).

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}` };
}

/** `YYYY-MM-DD` in the project's timezone. */
export function localDate(at: Date | string, timeZone: string): string {
  return parts(typeof at === "string" ? new Date(at) : at, timeZone).date;
}

/** `YYYY-MM-DDTHH:mm` in the project's timezone. */
export function localDateTime(at: Date | string, timeZone: string): string {
  const p = parts(typeof at === "string" ? new Date(at) : at, timeZone);
  return `${p.date}T${p.time}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
