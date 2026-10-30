'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export interface TabItem {
  value: string;
  label: string;
  href?: string;
  icon?: LucideIcon;
  count?: number;
}

export type TabsVariant = 'underline' | 'pill';

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange?: (value: string) => void;
  variant?: TabsVariant;
  fullWidth?: boolean;
  ariaLabel?: string;
  className?: string;
}

/**
 * Navegación por tabs. Si el item tiene `href` navega con Link; si no, usa un
 * botón controlado por `onChange`. No implementa paneles ARIA: es una barra de
 * navegación, no un tabs widget con contenido oculto.
 */
export default function Tabs({
  items,
  value,
  onChange,
  variant = 'underline',
  fullWidth = false,
  ariaLabel = 'Secciones',
  className,
}: TabsProps) {
  const isPill = variant === 'pill';

  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        isPill
          ? 'inline-flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-surface-muted p-1'
          : 'flex gap-6 overflow-x-auto border-b border-border',
        fullWidth && 'w-full',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        const Icon = item.icon;
        const itemClasses = cn(
          'inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:min-h-11',
          isPill
            ? cn(
                'rounded-md px-3 py-1.5',
                active
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted hover:text-foreground',
                fullWidth && 'flex-1 justify-center',
              )
            : cn(
                '-mb-px border-b-2 px-1 py-2',
                active
                  ? 'border-action text-foreground'
                  : 'border-transparent text-muted hover:text-foreground',
              ),
        );

        const content = (
          <>
            {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
            <span>{item.label}</span>
            {typeof item.count === 'number' ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                  active ? 'bg-action-soft text-action-text' : 'bg-surface-muted text-subtle',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </>
        );

        if (item.href) {
          return (
            <Link
              key={item.value}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              onClick={() => onChange?.(item.value)}
              className={itemClasses}
            >
              {content}
            </Link>
          );
        }

        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange?.(item.value)}
            className={itemClasses}
          >
            {content}
          </button>
        );
      })}
    </nav>
  );
}
