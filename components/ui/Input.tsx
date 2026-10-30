'use client';

import { useId, type InputHTMLAttributes } from 'react';
import { Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import {
  controlClasses,
  errorControlClasses,
  Field,
  fieldDescribedBy,
} from '@/components/ui/Field';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Etiqueta persistente; no se usa el placeholder como etiqueta. */
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  /** Icono decorativo a la izquierda (búsqueda, usuario, etc.). */
  leadingIcon?: LucideIcon;
  /** Clases del contenedor Field (no del input). */
  fieldClassName?: string;
}

/**
 * Campo de texto con etiqueta, ayuda y error accesibles. El ID se genera si no
 * se provee; el control mantiene 44 px de alto y 16 px en mobile para evitar el
 * zoom automático de iOS.
 */
export default function Input({
  id,
  label,
  hint,
  error,
  optional,
  required,
  leadingIcon: LeadingIcon,
  className,
  fieldClassName,
  ...props
}: InputProps) {
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
        {LeadingIcon ? (
          <LeadingIcon
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
        ) : null}
        <input
          {...props}
          id={fieldId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            controlClasses,
            LeadingIcon && 'pl-10',
            error && errorControlClasses,
            className,
          )}
        />
      </div>
    </Field>
  );
}

/** Atajo para el buscador con icono y type="search". */
export function SearchInput(props: Omit<InputProps, 'type' | 'leadingIcon'>) {
  return <Input {...props} type="search" leadingIcon={Search} />;
}
