import { createContext, useContext, type ReactNode } from "react";
import type { Services } from "./types";
import { createMockServices } from "./mock/services";

// Swap `createMockServices()` for an API-backed implementation of `Services`
// when the backend exists; nothing else in the UI needs to change.
export const defaultServices: Services = createMockServices();

const ServicesContext = createContext<Services>(defaultServices);

export function ServicesProvider({ services = defaultServices, children }: { services?: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  return useContext(ServicesContext);
}

export type { Services } from "./types";
