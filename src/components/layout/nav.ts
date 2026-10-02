import type { LucideIcon } from "lucide-react";
import { Boxes, ClipboardList, History, Sparkles, Store } from "lucide-react";

export interface NavEntry {
  to: "/" | "/pedidos" | "/proveedores" | "/materiales" | "/actividad";
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  /** Extra path prefixes that keep the item active. */
  match: string[];
}

export const NAV: NavEntry[] = [
  { to: "/", label: "Asistente", shortLabel: "Asistente", icon: Sparkles, match: ["/atencion"] },
  { to: "/pedidos", label: "Pedidos", shortLabel: "Pedidos", icon: ClipboardList, match: ["/pedidos"] },
  { to: "/proveedores", label: "Proveedores", shortLabel: "Proveedores", icon: Store, match: ["/proveedores"] },
  { to: "/materiales", label: "Materiales y cómputo", shortLabel: "Materiales", icon: Boxes, match: ["/materiales"] },
  { to: "/actividad", label: "Actividad", shortLabel: "Actividad", icon: History, match: ["/actividad"] },
];

export function isActive(entry: NavEntry, pathname: string): boolean {
  if (entry.to === "/") return pathname === "/" || entry.match.some((m) => pathname.startsWith(m));
  return entry.match.some((m) => pathname.startsWith(m));
}
