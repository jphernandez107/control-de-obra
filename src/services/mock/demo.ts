import type { Scenario } from "./db";

// Demo switches for evaluating UI states without a backend. Set once via the
// URL (`?demo=nuevo`, `?demo=sin-computo`, `?demo=cargando`, `?demo=error`,
// combinable with commas) and kept for the browser session. `?demo=reset`
// returns to the default scenario.

export type SimulateMode = "normal" | "cargando" | "error";

export interface DemoConfig {
  scenario: Scenario;
  computationLoaded: boolean;
  simulate: SimulateMode;
}

const STORAGE_KEY = "cdo-demo";
const DEFAULT_CONFIG: DemoConfig = { scenario: "en-curso", computationLoaded: true, simulate: "normal" };

function parse(value: string): DemoConfig {
  const flags = value.split(",").map((f) => f.trim().toLowerCase());
  return {
    scenario: flags.includes("nuevo") ? "nuevo" : "en-curso",
    computationLoaded: !flags.includes("sin-computo") && !flags.includes("nuevo"),
    simulate: flags.includes("cargando") ? "cargando" : flags.includes("error") ? "error" : "normal",
  };
}

function readStorage(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable (private mode); the URL still works.
  }
}

export function readDemoConfig(): DemoConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  const fromUrl = new URLSearchParams(window.location.search).get("demo");
  if (fromUrl !== null) {
    if (fromUrl === "reset" || fromUrl === "") {
      writeStorage(null);
      return DEFAULT_CONFIG;
    }
    writeStorage(fromUrl);
    return parse(fromUrl);
  }
  const stored = readStorage();
  return stored ? parse(stored) : DEFAULT_CONFIG;
}
