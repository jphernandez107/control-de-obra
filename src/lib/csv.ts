/** Downloads rows as a CSV file (semicolon-separated, UTF-8 with BOM so Excel in Spanish opens it correctly). */
export function downloadCsv(fileName: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const text = v === null || v === undefined ? "" : typeof v === "number" ? String(v).replace(".", ",") : v;
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Minor units → plain decimal pesos for spreadsheets ("1482340,5"). */
export function csvMoney(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  const whole = Math.trunc(minor / 100);
  const cents = Math.abs(minor % 100);
  return cents ? `${whole},${String(cents).padStart(2, "0")}` : String(whole);
}
