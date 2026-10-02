import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "./cn";

export const SearchField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { onClear?: () => void; containerClassName?: string }>(
  function SearchField({ className, containerClassName, onClear, value, ...rest }, ref) {
    return (
      <label
        className={cn(
          "flex h-10 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent",
          containerClassName,
        )}
      >
        <Search size={16} className="shrink-0 text-fg-3" />
        <input ref={ref} type="search" value={value} className={cn("min-w-0 flex-1 bg-transparent text-sm text-fg outline-none [&::-webkit-search-cancel-button]:hidden", className)} {...rest} />
        {onClear && value ? (
          <button type="button" aria-label="Borrar búsqueda" onClick={onClear} className="text-fg-3 hover:text-fg">
            <X size={14} />
          </button>
        ) : null}
      </label>
    );
  },
);

export function FilterChip({
  label,
  active,
  onClick,
  onRemove,
  dropdown = true,
  icon,
  count,
  className,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  dropdown?: boolean;
  icon?: ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={active && onRemove ? onRemove : onClick}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-2xl border px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
        active ? "border-fg bg-fg text-bg" : "border-border bg-surface text-fg-2 hover:bg-sunken",
        className,
      )}
    >
      {label}
      {count !== undefined ? <span className={cn("font-mono text-xs", active ? "text-bg/70" : "text-fg-3")}>{count}</span> : null}
      {icon}
      {active && onRemove ? <X size={14} /> : dropdown && !active ? <ChevronDown size={14} className="text-fg-3" /> : null}
    </button>
  );
}

/** Native select styled as a filter chip, so menus work on touch devices. */
export function SelectChip<T extends string>({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: T | "";
  options: { value: T; label: string }[];
  onChange: (value: T | "") => void;
  allLabel?: string;
}) {
  const current = options.find((o) => o.value === value);
  const active = Boolean(current);
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={cn(
          "pointer-events-none inline-flex h-8 items-center gap-1.5 rounded-2xl border px-3 text-[13px] font-medium whitespace-nowrap",
          active ? "border-fg bg-fg text-bg" : "border-border bg-surface text-fg-2",
        )}
      >
        {current ? current.label : label}
        {active ? <X size={14} /> : <ChevronDown size={14} className="text-fg-3" />}
      </span>
      {active ? (
        <button type="button" aria-label={`Quitar filtro ${current!.label}`} className="absolute inset-0" onClick={() => onChange("")} />
      ) : (
        <select
          aria-label={label}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={value}
          onChange={(e) => onChange(e.target.value as T | "")}
        >
          <option value="">{allLabel ?? label}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

export function TextInput({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      className={cn(
        "h-12 w-full rounded-[10px] border border-border-strong bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:bg-sunken disabled:text-fg-3",
        mono && "font-mono",
        className,
      )}
      {...rest}
    />
  );
}

export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-[13px] font-medium text-fg-2", className)}>{children}</span>;
}
