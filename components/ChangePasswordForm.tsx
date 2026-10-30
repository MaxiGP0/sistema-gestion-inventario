'use client';

import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useToast } from '@/context/ToastContext';
import { api } from '@/lib/api-client';
import {
  CHANGE_PASSWORD_SUCCESS_MESSAGE,
  EMPTY_CHANGE_PASSWORD_FORM,
  validateChangePasswordForm,
  type ChangePasswordField,
  type ChangePasswordFormErrors,
  type ChangePasswordFormValues,
} from '@/lib/change-password-form';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import type { ChangePasswordResponse } from '@/lib/types';

const FIELD_IDS: Record<ChangePasswordField, string> = {
  currentPassword: 'change-password-current',
  newPassword: 'change-password-new',
  confirmPassword: 'change-password-confirm',
};

const INITIAL_VISIBILITY: Record<ChangePasswordField, boolean> = {
  currentPassword: false,
  newPassword: false,
  confirmPassword: false,
};

interface PasswordFieldProps {
  field: ChangePasswordField;
  label: string;
  toggleLabel: string;
  autoComplete: 'current-password' | 'new-password';
  value: string;
  visible: boolean;
  error?: string;
  hint?: string;
  onChange: (value: string) => void;
  onToggle: () => void;
}

function PasswordField({
  field,
  label,
  toggleLabel,
  autoComplete,
  value,
  visible,
  error,
  hint,
  onChange,
  onToggle,
}: PasswordFieldProps) {
  const id = FIELD_IDS[field];
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-foreground">
        {label}
      </label>

      <div className="relative">
        <Lock
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
          aria-hidden="true"
        />
        <input
          id={id}
          name={field}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={`min-h-11 w-full rounded-md border bg-field py-3 pl-10 pr-14 text-base text-foreground outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus/30 ${
            error ? 'border-status-blocked-border' : 'border-border-strong'
          }`}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${visible ? 'Ocultar' : 'Mostrar'} ${toggleLabel}`}
          aria-pressed={visible}
          aria-controls={id}
          className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {visible ? (
            <EyeOff className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Eye className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      </div>

      {hint && (
        <p id={hintId} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-status-blocked">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Formulario de cambio de contraseña del usuario autenticado.
 *
 * `POST /api/auth/change-password` valida la clave actual, guarda el nuevo hash
 * e invalida las demás sesiones (sessionVersion). La respuesta renueva la
 * cookie de esta pestaña, así que el dispositivo actual sigue conectado.
 */
export default function ChangePasswordForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState<ChangePasswordFormValues>(EMPTY_CHANGE_PASSWORD_FORM);
  const [errors, setErrors] = useState<ChangePasswordFormErrors>({});
  const [visible, setVisible] = useState(INITIAL_VISIBILITY);
  const [submitting, setSubmitting] = useState(false);

  const updateField = (field: ChangePasswordField, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => {
      if (!previous[field]) return previous;

      const next = { ...previous };
      delete next[field];
      return next;
    });
  };

  const toggleVisibility = (field: ChangePasswordField) => {
    setVisible((previous) => ({ ...previous, [field]: !previous[field] }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextErrors = validateChangePasswordForm(values);
    setErrors(nextErrors);

    const firstError = (Object.keys(nextErrors) as ChangePasswordField[])[0];
    if (firstError) {
      document.getElementById(FIELD_IDS[firstError])?.focus();
      return;
    }

    setSubmitting(true);

    try {
      await api.post<ChangePasswordResponse>('/api/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });

      setValues(EMPTY_CHANGE_PASSWORD_FORM);
      setErrors({});
      setVisible(INITIAL_VISIBILITY);
      showToast(CHANGE_PASSWORD_SUCCESS_MESSAGE, 'success');
    } catch (error: unknown) {
      showToast(
        error instanceof Error ? error.message : 'No se pudo cambiar la contraseña',
        'error',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-5">
      <PasswordField
        field="currentPassword"
        label="Contraseña actual"
        toggleLabel="la contraseña actual"
        autoComplete="current-password"
        value={values.currentPassword}
        visible={visible.currentPassword}
        error={errors.currentPassword}
        onChange={(value) => updateField('currentPassword', value)}
        onToggle={() => toggleVisibility('currentPassword')}
      />

      <PasswordField
        field="newPassword"
        label="Nueva contraseña"
        toggleLabel="la nueva contraseña"
        autoComplete="new-password"
        value={values.newPassword}
        visible={visible.newPassword}
        error={errors.newPassword}
        hint={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres.`}
        onChange={(value) => updateField('newPassword', value)}
        onToggle={() => toggleVisibility('newPassword')}
      />

      <PasswordField
        field="confirmPassword"
        label="Confirmar nueva contraseña"
        toggleLabel="la confirmación de la nueva contraseña"
        autoComplete="new-password"
        value={values.confirmPassword}
        visible={visible.confirmPassword}
        error={errors.confirmPassword}
        onChange={(value) => updateField('confirmPassword', value)}
        onToggle={() => toggleVisibility('confirmPassword')}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted">
          Al cambiarla, se cierran las sesiones abiertas en otros dispositivos.
        </p>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={submitting}
          className="w-full shrink-0 sm:w-auto"
        >
          {submitting ? 'Guardando…' : 'Cambiar contraseña'}
        </Button>
      </div>
    </form>
  );
}
