'use client';

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export interface SegmentItem {
  value: string;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedControlProps {
  items: readonly SegmentItem[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  fullWidth?: boolean;
  className?: string;
}

/** Control segmentado para elegir una opción entre pocas, sin navegación. */
export default function SegmentedControl({
  items,
  value,
  onChange,
  ariaLabel,
  fullWidth = false,
  className,
}: SegmentedControlProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-surface-muted p-1',
        fullWidth && 'w-full',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        const Icon = item.icon;

        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:min-h-11',
              active ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground',
              fullWidth && 'flex-1 justify-center',
            )}
          >
            {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
