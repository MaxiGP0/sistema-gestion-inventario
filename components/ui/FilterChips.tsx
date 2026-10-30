'use client';

import { cn } from '@/components/ui/cn';

export interface FilterChipItem {
  value: string;
  label: string;
  count?: number;
  /** data-testid propio del chip, para selectores E2E estables. */
  testId?: string;
}

export interface FilterChipsProps {
  items: readonly FilterChipItem[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  /** data-testid del contenedor, para compatibilidad con las suites E2E. */
  dataTestId?: string;
  /** Prefijo del data-testid de cada chip, p. ej. `orders-tray-status-`. */
  itemTestIdPrefix?: string;
}

/** Chips de filtro de selección única, con scroll horizontal contenido. */
export default function FilterChips({
  items,
  value,
  onChange,
  ariaLabel,
  className,
  dataTestId,
  itemTestIdPrefix,
}: FilterChipsProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={cn('flex w-full max-w-full gap-2 overflow-x-auto pb-1', className)}
    >
      {items.map((item) => {
        const active = item.value === value;

        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            data-testid={
              item.testId ?? (itemTestIdPrefix ? `${itemTestIdPrefix}${item.value}` : undefined)
            }
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:min-h-11',
              active
                ? 'border-action/60 bg-action-soft text-action-text'
                : 'border-border bg-surface text-muted hover:border-border-strong hover:text-foreground',
            )}
          >
            <span>{item.label}</span>
            {typeof item.count === 'number' ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                  active ? 'bg-surface text-action-text' : 'bg-surface-muted text-subtle',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
