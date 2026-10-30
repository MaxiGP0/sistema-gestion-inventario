/**
 * Pruebas del bootstrap de sesión del layout raíz.
 *
 * `getInitialSessionUserFast` hidrata el `UserProvider` sin consultar Mongo:
 * - verifica la firma de la cookie,
 * - si el snapshot está en el caché en memoria, usa su rol/usuario/versión,
 * - si no está, devuelve las claims firmadas.
 *
 * La validación completa (`active`, `sessionVersion` y rol actual) sigue en
 * `requireCurrentSession` (escrituras) y en `getInitialSessionUser` (/login).
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveBootstrapSessionUser } from '../lib/auth';
import type { CurrentSessionSnapshot } from '../lib/current-session-cache';
import { createSessionToken, verifySessionToken, type SessionPayload } from '../lib/session';
import { TEST_AUTH_SECRET } from './test-auth-utils';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || TEST_AUTH_SECRET;

const USER_ID = 'a'.repeat(24);

function signedSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  const token = createSessionToken({
    userId: USER_ID,
    username: 'vendedor-firmado',
    role: 'vendedor',
    sessionVersion: 0,
  });

  const session = verifySessionToken(token);
  assert.ok(session, 'la sesión de prueba debe ser válida');

  return { ...session, ...overrides };
}

function cachedSnapshot(overrides: Partial<CurrentSessionSnapshot> = {}): CurrentSessionSnapshot {
  return {
    userId: USER_ID,
    username: 'vendedor-cacheado',
    role: 'vendedor',
    active: true,
    sessionVersion: 0,
    notificationsEnabled: true,
    expiresAt: Date.now() + 45_000,
    ...overrides,
  };
}

test('sin sesión firmada no hay usuario inicial', () => {
  assert.equal(resolveBootstrapSessionUser(null), null);
});

test('sin snapshot en memoria usa las claims firmadas, sin tocar Mongo', () => {
  const user = resolveBootstrapSessionUser(signedSession());

  assert.deepEqual(user, {
    id: USER_ID,
    username: 'vendedor-firmado',
    role: 'vendedor',
    notificationsEnabled: true,
  });
});

test('con snapshot en memoria prefiere el estado actual del usuario', () => {
  const user = resolveBootstrapSessionUser(
    signedSession(),
    cachedSnapshot({
      username: 'vendedor-renombrado',
      role: 'controlador',
      notificationsEnabled: false,
    }),
  );

  assert.deepEqual(user, {
    id: USER_ID,
    username: 'vendedor-renombrado',
    role: 'controlador',
    notificationsEnabled: false,
  });
});

test('un usuario desactivado en el snapshot no hidrata el contexto', () => {
  assert.equal(
    resolveBootstrapSessionUser(signedSession(), cachedSnapshot({ active: false })),
    null,
  );
});

test('un cambio de sessionVersion invalida la hidratación inicial', () => {
  assert.equal(
    resolveBootstrapSessionUser(signedSession(), cachedSnapshot({ sessionVersion: 1 })),
    null,
  );
});
