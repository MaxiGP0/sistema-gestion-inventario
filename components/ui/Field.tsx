import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/components/ui/cn';

/** Clases compartidas por input, select y textarea. */
export const controlClasses =
  'w-full min-h-11 rounded-md border border-border-strong bg-field px-3 py-2 text-sm text-foreground shadow-none outline-none transition-colors placeholder:text-subtle focus:border-focus focus:ring-2 focus:ring-focus/30 disabled:cursor-not-allowed disabled:border-border disabled:bg-disabled disabled:text-disabled-fg';

export const errorControlClasses =
  'border-status-blocked focus:border-status-blocked focus:ring-status-blocked/30';

export function fieldDescribedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Etiqueta persistente, marca de obligatorio/opcional y ayuda/error fuera del
 * control, según el sistema de diseño. El control se pasa como children.
 */
export function Field({
  id,
  label,
  required = false,
  optional = false,
  hint,
  error,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-foreground">
          {label}
        </label>
        {optional ? (
          <span className="text-xs text-subtle">Opcional</span>
        ) : required ? (
          <span className="text-xs text-subtle">Obligatorio</span>
        ) : null}
      </div>

      {children}

      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-xs text-status-blocked">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
