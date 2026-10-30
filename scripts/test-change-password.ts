/**
 * Pruebas del formulario de cambio de contraseña:
 * - La validación del cliente exige la clave actual, el mínimo/máximo y la
 *   confirmación coincidente.
 * - El mensaje de éxito aclara que se cerraron las otras sesiones.
 * - La política compartida coincide con `changePasswordSchema` del servidor.
 *
 * La integración del endpoint (hash, sessionVersion y cookie renovada) se
 * ejercita en scripts/test-users-admin.ts.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHANGE_PASSWORD_SUCCESS_MESSAGE,
  EMPTY_CHANGE_PASSWORD_FORM,
  validateChangePasswordForm,
} from '../lib/change-password-form';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../lib/password-policy';
import { changePasswordSchema } from '../lib/validations';

const VALID_VALUES = {
  currentPassword: 'clave-actual',
  newPassword: 'nueva-clave',
  confirmPassword: 'nueva-clave',
};

test('acepta un cambio completo y válido', () => {
  assert.deepEqual(validateChangePasswordForm(VALID_VALUES), {});
});

test('exige la contraseña actual y la confirmación', () => {
  const errors = validateChangePasswordForm({
    ...EMPTY_CHANGE_PASSWORD_FORM,
    newPassword: 'nueva-clave',
  });

  assert.equal(errors.currentPassword, 'Ingresá tu contraseña actual.');
  assert.equal(errors.confirmPassword, 'Repetí la nueva contraseña.');
  assert.equal(errors.newPassword, undefined);
});

test('aplica el mínimo y el máximo de la política de contraseñas', () => {
  const tooShort = validateChangePasswordForm({
    ...VALID_VALUES,
    newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
    confirmPassword: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
  });
  assert.match(tooShort.newPassword ?? '', new RegExp(`al menos ${PASSWORD_MIN_LENGTH}`));

  const minimum = validateChangePasswordForm({
    ...VALID_VALUES,
    newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH),
    confirmPassword: 'a'.repeat(PASSWORD_MIN_LENGTH),
  });
  assert.deepEqual(minimum, {});

  const tooLong = validateChangePasswordForm({
    ...VALID_VALUES,
    newPassword: 'a'.repeat(PASSWORD_MAX_LENGTH + 1),
    confirmPassword: 'a'.repeat(PASSWORD_MAX_LENGTH + 1),
  });
  assert.match(tooLong.newPassword ?? '', new RegExp(`superar los ${PASSWORD_MAX_LENGTH}`));
});

test('rechaza una confirmación distinta', () => {
  const errors = validateChangePasswordForm({
    ...VALID_VALUES,
    confirmPassword: 'otra-clave',
  });

  assert.equal(errors.confirmPassword, 'Las contraseñas nuevas no coinciden.');
  assert.equal(errors.newPassword, undefined);
});

test('el mensaje de éxito menciona el cierre de las otras sesiones', () => {
  assert.match(CHANGE_PASSWORD_SUCCESS_MESSAGE, /Contraseña actualizada/);
  assert.match(CHANGE_PASSWORD_SUCCESS_MESSAGE, /sesiones en otros dispositivos/);
});

test('changePasswordSchema del servidor usa la misma política', () => {
  const base = { currentPassword: 'clave-actual' };

  assert.equal(
    changePasswordSchema.safeParse({ ...base, newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH) })
      .success,
    true,
  );
  assert.equal(
    changePasswordSchema.safeParse({
      ...base,
      newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
    }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({
      ...base,
      newPassword: 'a'.repeat(PASSWORD_MAX_LENGTH + 1),
    }).success,
    false,
  );
  assert.equal(changePasswordSchema.safeParse({ newPassword: 'nueva-clave' }).success, false);
});
