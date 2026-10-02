// Document bytes live behind this interface; metadata lives in the
// `documents` table. Local development uses the filesystem adapter; a
// Cloudflare deployment can implement the same three methods on R2
// (`bucket.put/get/delete`) without touching domain code.

export interface StoredObject {
  data: Uint8Array;
  contentType?: string;
}

export interface DocumentStorage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

/** In-memory adapter for tests. */
export class MemoryStorage implements DocumentStorage {
  private objects = new Map<string, StoredObject>();
  async put(key: string, data: Uint8Array, contentType: string) {
    this.objects.set(key, { data, contentType });
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
