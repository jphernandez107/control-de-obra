import { createSeed, type Db } from "./db";
import { readDemoConfig, type DemoConfig } from "./demo";

export const demo: DemoConfig = readDemoConfig();

export const db: Db = createSeed(demo.scenario, demo.computationLoaded);

export function nextId(prefix: string): string {
  db.seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${db.seq}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const failedOnce = new Set<string>();

/**
 * Wraps list/overview reads with fake latency and the demo loading/error modes.
 * In error mode each key fails once, so "Reintentar" demonstrates recovery.
 */
export async function simulated<T>(key: string, read: () => T, latency = 380): Promise<T> {
  if (demo.simulate === "cargando") {
    await new Promise(() => {});
  }
  await delay(latency + Math.round(Math.random() * 180));
  if (demo.simulate === "error" && !failedOnce.has(key)) {
    failedOnce.add(key);
    throw new Error("Servicio no disponible (503)");
  }
  return structuredClone(read());
}

export async function quick<T>(read: () => T, latency = 220): Promise<T> {
  await delay(latency);
  return structuredClone(read());
}
