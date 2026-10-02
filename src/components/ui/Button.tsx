import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger-ghost" | "ai" | "outline";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "bg-surface text-fg border border-border-strong hover:bg-sunken",
  outline: "bg-surface text-fg-2 border border-border hover:bg-sunken",
  ghost: "bg-transparent text-fg-2 hover:bg-surface-2",
  "danger-ghost": "bg-transparent text-danger hover:bg-danger-soft",
  ai: "bg-ai text-on-accent hover:opacity-90",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm gap-2",
  md: "h-11 px-4 text-[15px] gap-2",
  lg: "h-12 px-4 text-[15px] gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", icon: Icon, iconRight: IconRight, loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[10px] font-medium whitespace-nowrap transition-colors disabled:opacity-60",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={18} className="animate-spin" /> : Icon ? <Icon size={18} strokeWidth={2} /> : null}
      {children}
      {IconRight ? <IconRight size={16} /> : null}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  size?: 40 | 44 | 48;
  round?: boolean;
  iconSize?: number;
  tone?: "default" | "accent" | "accent-soft" | "plain";
}

export function IconButton({ icon: Icon, label, size = 40, round, iconSize, tone = "default", className, type = "button", ...rest }: IconButtonProps) {
  const tones = {
    default: "bg-surface border border-border text-fg-2 hover:bg-sunken",
    accent: "bg-accent text-on-accent hover:bg-accent-hover",
    "accent-soft": "bg-accent-soft text-accent",
    plain: "text-fg-2 hover:bg-surface-2",
  } as const;
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn("inline-flex shrink-0 items-center justify-center transition-colors", round ? "rounded-full" : "rounded-[10px]", tones[tone], className)}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon size={iconSize ?? (size >= 44 ? 20 : 18)} />
    </button>
  );
}

/** Text-only action used in section headers ("Editar", "+ Registrar", "Ver todo"). */
export function LinkButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn("text-[13px] font-medium text-accent hover:underline", className)} {...rest} />;
}
