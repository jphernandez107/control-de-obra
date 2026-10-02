import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { DocumentStorage, StoredObject } from "./storage";

/** Node-only adapter: stores each document as a file under `root`. */
export class LocalFileStorage implements DocumentStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error("Clave de documento inválida");
    return path;
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    await writeFile(`${path}.meta.json`, JSON.stringify({ contentType }));
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const data = new Uint8Array(await readFile(path));
      let contentType: string | undefined;
      try {
        contentType = (JSON.parse(await readFile(`${path}.meta.json`, "utf8")) as { contentType?: string }).contentType;
      } catch {
        contentType = undefined;
      }
      return { data, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true });
  }
}
