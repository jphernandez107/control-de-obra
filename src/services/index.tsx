import { createContext, useContext, type ReactNode } from "react";
import type { Services } from "./types";
import { createApiServices } from "./api/services";

// Every screen reads and writes through these services, backed by the API.
export const defaultServices: Services = createApiServices();

const ServicesContext = createContext<Services>(defaultServices);

export function ServicesProvider({ services = defaultServices, children }: { services?: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  return useContext(ServicesContext);
}

export type { Services } from "./types";
