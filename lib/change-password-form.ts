/**
 * Validación y mensajes del formulario "Cambiar contraseña".
 *
 * La lógica vive fuera del componente para poder probarla sin DOM y para que
 * el formulario cliente no dependa de `lib/validations.ts` (que importa Zod y
 * los esquemas de pedidos). El servidor sigue validando con
 * `changePasswordSchema` como última línea de defensa.
 */

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH_MESSAGE,
  PASSWORD_MIN_LENGTH_MESSAGE,
} from './password-policy';

export const CHANGE_PASSWORD_SUCCESS_MESSAGE =
  'Contraseña actualizada. Se cerraron las sesiones en otros dispositivos.';

export interface ChangePasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type ChangePasswordField = keyof ChangePasswordFormValues;

export type ChangePasswordFormErrors = Partial<Record<ChangePasswordField, string>>;

export const EMPTY_CHANGE_PASSWORD_FORM: ChangePasswordFormValues = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

/** Valida los tres campos y devuelve sólo los mensajes de los inválidos. */
export function validateChangePasswordForm(
  values: ChangePasswordFormValues,
): ChangePasswordFormErrors {
  const errors: ChangePasswordFormErrors = {};

  if (!values.currentPassword) {
    errors.currentPassword = 'Ingresá tu contraseña actual.';
  }

  if (!values.newPassword) {
    errors.newPassword = 'Ingresá la nueva contraseña.';
  } else if (values.newPassword.length < PASSWORD_MIN_LENGTH) {
    errors.newPassword = PASSWORD_MIN_LENGTH_MESSAGE;
  } else if (values.newPassword.length > PASSWORD_MAX_LENGTH) {
    errors.newPassword = PASSWORD_MAX_LENGTH_MESSAGE;
  }

  if (!values.confirmPassword) {
    errors.confirmPassword = 'Repetí la nueva contraseña.';
  } else if (values.confirmPassword !== values.newPassword) {
    errors.confirmPassword = 'Las contraseñas nuevas no coinciden.';
  }

  return errors;
}
