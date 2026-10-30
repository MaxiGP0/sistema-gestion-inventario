'use client';

import { useId, type InputHTMLAttributes } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { fieldDescribedBy } from '@/components/ui/Field';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  hint?: string;
  error?: string;
}

/** Checkbox nativo con etiqueta y mensajes accesibles. */
export default function Checkbox({
  id,
  label,
  hint,
  error,
  className,
  disabled,
  ...props
}: CheckboxProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy = fieldDescribedBy(fieldId, hint, error);

  return (
    <div className={cn('space-y-1.5', disabled && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <input
          {...props}
          id={fieldId}
          type="checkbox"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'mt-0.5 h-5 w-5 shrink-0 rounded border-border-strong accent-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed',
            error && 'border-status-blocked',
            className,
          )}
        />
        <label htmlFor={fieldId} className="text-sm leading-5 text-foreground">
          {label}
        </label>
      </div>

      {error ? (
        <p
          id={`${fieldId}-error`}
          className="ml-8 flex items-start gap-1.5 text-xs text-status-blocked"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="ml-8 text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
