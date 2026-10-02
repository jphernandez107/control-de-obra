// Minimal CSV and XLSX readers built on Web APIs (TextDecoder,
// DecompressionStream), so they run in Node and on Cloudflare Workers.

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseCsv(data: Uint8Array): string[][] {
  let text = new TextDecoder("utf-8").decode(data);
  if (text.includes("�")) text = new TextDecoder("latin1").decode(data);
  text = text.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0]!;
  const delimiter = [";", "\t", ","].sort((a, b) => head.split(b).length - head.split(a).length)[0]!;
  return lines.map((l) => splitCsvLine(l, delimiter));
}

function u16(b: Uint8Array, o: number) {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number) {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(data: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("No es un archivo XLSX válido");
  const count = u16(data, eocd + 10);
  let offset = u32(data, eocd + 16);
  const files = new Map<string, string>();
  const decoder = new TextDecoder("utf-8");
  for (let n = 0; n < count; n++) {
    if (u32(data, offset) !== 0x02014b50) break;
    const method = u16(data, offset + 10);
    const compressedSize = u32(data, offset + 20);
    const nameLen = u16(data, offset + 28);
    const extraLen = u16(data, offset + 30);
    const commentLen = u16(data, offset + 32);
    const localOffset = u32(data, offset + 42);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = localOffset + 30 + u16(data, localOffset + 26) + u16(data, localOffset + 28);
    const raw = data.subarray(start, start + compressedSize);
    const bytes = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
    if (bytes) files.set(name, decoder.decode(bytes));
  }
  return files;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/** First worksheet of an .xlsx file as rows of cell text. */
export async function parseXlsx(data: Uint8Array): Promise<string[][]> {
  const files = await unzip(data, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
  const sheetName = [...files.keys()].filter((n) => n.startsWith("xl/worksheets/")).sort()[0];
  if (!sheetName) return [];
  const rows: string[][] = [];
  for (const row of files.get(sheetName)!.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1]!.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)] ?? "";
      else if (type === "inlineStr") value = decodeXml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
      else value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      cells[ref ? columnIndex(ref) : cells.length] = value.trim();
    }
    rows.push(Array.from(cells, (v) => v ?? ""));
  }
  return rows.filter((r) => r.some((c) => c));
}
