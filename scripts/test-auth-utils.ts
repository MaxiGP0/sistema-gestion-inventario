/**
 * Utilidades compartidas por los tests para autenticar requests contra los
 * route handlers sin base de datos: firma una sesión de prueba con el mismo
 * lib/session.ts que usa la app.
 *
 * Al importar este módulo se define AUTH_SECRET (si no estaba) para que la
 * firma/verificación funcione en el entorno de tests.
 */

import type { UserRole } from '../lib/authz';
import { primeCurrentSessionCache } from '../lib/current-session-cache';
import { createSessionToken, sessionCookieName } from '../lib/session';
import { User } from '../models/User';

export const TEST_AUTH_SECRET = 'test-auth-secret-sgi-0123456789';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || TEST_AUTH_SECRET;
// Los tests ejercitan cientos de requests; solo interesan los errores reales.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const DEFAULT_TEST_USER_ID = '000000000000000000000001';

/**
 * Si el test stubbeó `User.findById` (p. ej. para simular una baja), la sesión
 * actual debe consultar ese stub en vez de usar el atajo del caché.
 */
function isUserLookupMocked(): boolean {
  return Boolean((User as unknown as { findById?: { mock?: unknown } }).findById?.mock);
}

/**
 * Header `Cookie` con una sesión firmada del rol (y usuario) pedido.
 *
 * También prepara el caché de `requireCurrentSession` con el mismo estado, de
 * modo que los tests que no necesitan base puedan ejercitar rutas de escritura
 * sin una conexión real. Si el test mockea `User.findById`, no se prepara el
 * caché: así puede simular usuarios desactivados, eliminados o con otro rol.
 */
export function testSessionCookie(
  role: UserRole = 'admin',
  userId: string = DEFAULT_TEST_USER_ID,
  sessionVersion = 0,
): string {
  const username = `test-${role}`;

  if (!isUserLookupMocked()) {
    primeCurrentSessionCache({
      userId,
      username,
      role,
      active: true,
      sessionVersion,
      notificationsEnabled: true,
    });
  }

  const token = createSessionToken({
    userId,
    username,
    role,
    sessionVersion,
  });

  return `${sessionCookieName()}=${token}`;
}

/** Agrega la cookie de sesión a un `RequestInit` (sin pisar headers propios). */
export function withTestAuth(
  init: RequestInit = {},
  role: UserRole = 'admin',
  userId: string = DEFAULT_TEST_USER_ID,
  sessionVersion = 0,
): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('cookie', testSessionCookie(role, userId, sessionVersion));

  return { ...init, headers };
}

/** Request autenticado con el rol y usuario indicados (admin por defecto). */
export function authRequest(
  url: string,
  init: RequestInit = {},
  role: UserRole = 'admin',
  userId: string = DEFAULT_TEST_USER_ID,
  sessionVersion = 0,
): Request {
  return new Request(url, withTestAuth(init, role, userId, sessionVersion));
}
