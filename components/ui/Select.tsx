'use client';

import { useId, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import {
  controlClasses,
  errorControlClasses,
  Field,
  fieldDescribedBy,
} from '@/components/ui/Field';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  fieldClassName?: string;
}

/** Select nativo con la misma etiqueta, ayuda y error que Input. */
export default function Select({
  id,
  label,
  hint,
  error,
  optional,
  required,
  className,
  fieldClassName,
  children,
  ...props
}: SelectProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy = fieldDescribedBy(fieldId, hint, error);

  return (
    <Field
      id={fieldId}
      label={label}
      required={required}
      optional={optional}
      hint={hint}
      error={error}
      className={fieldClassName}
    >
      <div className="relative">
        <select
          {...props}
          id={fieldId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            controlClasses,
            'appearance-none pr-10',
            error && errorControlClasses,
            className,
          )}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
          aria-hidden="true"
        />
      </div>
    </Field>
  );
}
