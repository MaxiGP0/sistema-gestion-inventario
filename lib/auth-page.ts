import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { resolveCurrentSessionUser } from './auth';
import type { UserRole } from './authz';
import { readSessionToken, verifySessionToken, type SessionPayload } from './session';

export type PageAuthDecision =
  { status: 'ok'; session: SessionPayload } | { status: 'login' } | { status: 'forbidden' };

/**
 * Resuelve la guarda de una página sin redirigir.
 *
 * La cookie firmada por sí sola no alcanza: entre el login y el vencimiento
 * (8 h) el usuario puede ser dado de baja, cambiar de rol o resetear su
 * contraseña. Por eso se consulta el estado actual con la misma caché de
 * 30-60 s que usan las escrituras (`resolveCurrentSessionUser`). Un usuario
 * inexistente/inactivo o una `sessionVersion` vieja implican sesión inválida;
 * un rol actual fuera de la allowlist implica falta de acceso.
 *
 * Se exporta por separado de `requireCurrentRolePage` para poder testear la
 * decisión sin depender de `redirect()`, que lanza una excepción interna.
 */
export async function resolveCurrentRolePageSession(
  allowedRoles: readonly UserRole[],
): Promise<PageAuthDecision> {
  // La verificación usa `Date.now()`: sin esto Cache Components intenta
  // prerenderizar la página y rechaza el valor inestable.
  await connection();

  const cookieStore = await cookies();
  const token = readSessionToken((name) => cookieStore.get(name)?.value);
  const signed = verifySessionToken(token);

  return authorizeCurrentPageSession(signed, allowedRoles);
}

/**
 * Decisión pura de la guarda una vez verificada/firmada la sesión. Se separa
 * para poder testear la baja, el cambio de rol y la allowlist sin depender de
 * `cookies()` ni de `redirect()`.
 */
export async function authorizeCurrentPageSession(
  signed: SessionPayload | null,
  allowedRoles: readonly UserRole[],
): Promise<PageAuthDecision> {
  if (!signed) return { status: 'login' };

  const currentUser = await resolveCurrentSessionUser(signed);
  if (!currentUser) return { status: 'login' };

  // El rol que decide es el de la base, no el firmado en la cookie.
  const session: SessionPayload = {
    ...signed,
    username: currentUser.username || signed.username,
    role: currentUser.role,
    sessionVersion: currentUser.sessionVersion,
  };

  if (!allowedRoles.includes(session.role)) return { status: 'forbidden' };

  return { status: 'ok', session };
}

/**
 * Guarda de las páginas server-side que exigen uno de los roles indicados.
 *
 * Redirige a `/login` si la sesión ya no es válida (usuario eliminado,
 * desactivado o con `sessionVersion` vieja) y a `/` si el rol actual no tiene
 * acceso. El proxy sigue exigiendo la firma para no consultar Mongo en cada
 * request; esta guarda es la que aplica el estado real del usuario.
 */
export async function requireCurrentRolePage(
  allowedRoles: readonly UserRole[],
): Promise<SessionPayload> {
  const decision = await resolveCurrentRolePageSession(allowedRoles);

  if (decision.status === 'login') redirect('/login');
  if (decision.status === 'forbidden') redirect('/');

  return decision.session;
}

/** Alias histórico: todas las guardas de página revalidan el estado actual. */
export async function requireRolePage(allowedRoles: readonly UserRole[]): Promise<SessionPayload> {
  return requireCurrentRolePage(allowedRoles);
}

/** Guarda de las páginas del backoffice: solo administradores. */
export async function requireAdminPage(): Promise<SessionPayload> {
  return requireCurrentRolePage(['admin']);
}
