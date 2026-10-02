import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: ["bg", "surface", "surface-2", "sunken", "border", "border-strong", "fg", "fg-2", "fg-3", "accent", "accent-hover", "accent-soft", "on-accent", "info", "info-soft", "success", "success-soft", "warning", "warning-soft", "danger", "danger-soft", "ai", "ai-soft", "scrim"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
