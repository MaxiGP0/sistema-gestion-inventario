'use client';

import { useId, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/components/ui/cn';
import {
  controlClasses,
  errorControlClasses,
  Field,
  fieldDescribedBy,
} from '@/components/ui/Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  fieldClassName?: string;
}

/** Área de texto para comentarios u observaciones, con etiqueta persistente. */
export default function Textarea({
  id,
  label,
  hint,
  error,
  optional,
  required,
  className,
  fieldClassName,
  ...props
}: TextareaProps) {
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
      <textarea
        {...props}
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          controlClasses,
          'min-h-28 resize-y py-3',
          error && errorControlClasses,
          className,
        )}
      />
    </Field>
  );
}
