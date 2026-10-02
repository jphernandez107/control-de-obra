import type { R2Bucket } from "@cloudflare/workers-types";
import { DomainError } from "../domain/errors";
import type { DocumentStorage, StoredObject } from "./storage";

/** Cloudflare adapter: documents live in a private R2 bucket, read only through the authenticated API. */
export class R2Storage implements DocumentStorage {
  constructor(private readonly bucket: R2Bucket) {}

  private check(key: string): string {
    if (!key || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new Error("Clave de documento inválida");
    }
    return key;
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(this.check(key), data, { httpMetadata: { contentType } });
  }

  async get(key: string): Promise<StoredObject | null> {
    const obj = await this.bucket.get(this.check(key));
    if (!obj) return null;
    return { data: new Uint8Array(await obj.arrayBuffer()), contentType: obj.httpMetadata?.contentType };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(this.check(key));
  }
}

/** Used when no bucket is bound: uploads fail with a clear message instead of crashing. */
export class UnavailableStorage implements DocumentStorage {
  private fail(): never {
    throw new DomainError("unsupported_document", "La carga de documentos no está habilitada en este entorno.");
  }
  async put(): Promise<void> {
    this.fail();
  }
  async get(): Promise<StoredObject | null> {
    this.fail();
  }
  async delete(): Promise<void> {
    this.fail();
  }
}
