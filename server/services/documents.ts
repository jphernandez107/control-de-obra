import { eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import * as t from "../db/schema";
import { DomainError } from "../domain/errors";
import type { DocumentStorage } from "../storage/storage";
import { newId } from "./context";
import type { DocumentKindCode } from "./commands";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const ACCEPTED = new Set(Object.values(EXTENSION_TYPES));

/** Formats the AI providers can read directly. */
export const AI_READABLE = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"]);

export function detectMimeType(fileName: string, declared?: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (declared && ACCEPTED.has(declared)) return declared;
  return EXTENSION_TYPES[ext] ?? declared ?? "application/octet-stream";
}

/** Magic-number check so a renamed file isn't stored as something it is not. */
function sniff(data: Uint8Array): string | null {
  const b = data;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x50 && b[1] === 0x4b) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/heic";
  return null;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\-]+/g, "_").slice(-80) || "documento";
}

export interface UploadInput {
  fileName: string;
  mimeType?: string;
  data: Uint8Array;
  kind?: DocumentKindCode;
  supplierId?: string | null;
}

/**
 * Stores the bytes and the metadata of an uploaded document. Uploading alone
 * changes no business record: the document is linked (and audited) when the
 * record it supports is confirmed.
 */
export async function storeDocument(deps: { db: AppDb; storage: DocumentStorage; projectId: string; userId: string; now: () => Date }, input: UploadInput) {
  if (!input.data.byteLength) throw new DomainError("unsupported_document", "El archivo está vacío.");
  if (input.data.byteLength > MAX_DOCUMENT_BYTES) throw new DomainError("unsupported_document", "El archivo supera los 20 MB.");
  const declared = detectMimeType(input.fileName, input.mimeType);
  const sniffed = sniff(input.data);
  const isText = declared === "text/csv";
  const mimeType = isText ? declared : sniffed ?? declared;
  if (!ACCEPTED.has(mimeType) || (!isText && !sniffed)) {
    throw new DomainError("unsupported_document", "Formato no soportado. Sube un PDF, una foto (JPG, PNG, WEBP o HEIC) o una planilla CSV/XLSX.");
  }
  const id = newId();
  const now = deps.now();
  const key = `${deps.projectId}/${now.toISOString().slice(0, 7)}/${id}-${safeName(input.fileName)}`;
  await deps.storage.put(key, input.data, mimeType);
  const row = {
    id,
    projectId: deps.projectId,
    kind: input.kind ?? "other",
    fileName: input.fileName.slice(0, 200),
    mimeType,
    sizeBytes: input.data.byteLength,
    storageKey: key,
    sha256: await sha256(input.data),
    supplierId: input.supplierId ?? null,
    documentDate: null,
    uploadedBy: deps.userId,
    uploadedAt: now.toISOString(),
  };
  try {
    await deps.db.insert(t.documents).values(row);
  } catch (err) {
    await deps.storage.delete(key).catch(() => undefined);
    throw new DomainError("persistence", "No se pudo guardar el documento.", String(err));
  }
  return row;
}

export async function getDocument(db: AppDb, projectId: string, id: string) {
  const [doc] = await db.select().from(t.documents).where(eq(t.documents.id, id));
  if (!doc || doc.projectId !== projectId) throw new DomainError("not_found", "Documento no encontrado");
  return doc;
}

export async function readDocumentBytes(storage: DocumentStorage, doc: { storageKey: string }) {
  const obj = await storage.get(doc.storageKey);
  if (!obj) throw new DomainError("not_found", "El archivo del documento no está disponible.");
  return obj.data;
}
