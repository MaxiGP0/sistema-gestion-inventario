import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import type { UserRole } from './authz';
import { readSessionToken, verifySessionToken, type SessionPayload } from './session';

/**
 * Guarda de las páginas server-side que exigen uno de los roles indicados.
 *
 * El proxy ya exige sesión y rol, pero las páginas vuelven a verificar la
 * cookie firmada (defensa en profundidad). `connection()` y `cookies()`
 * convierten el árbol en request-time: el build no intenta conectarse a Mongo
 * para prerenderizar datos del catálogo ni evalúa la fecha de la sesión.
 */
export async function requireRolePage(allowedRoles: readonly UserRole[]): Promise<SessionPayload> {
  // La verificación usa `Date.now()`: sin esto Cache Components intenta
  // prerenderizar la página y rechaza el valor inestable.
  await connection();

  const cookieStore = await cookies();
  const token = readSessionToken((name) => cookieStore.get(name)?.value);
  const session = verifySessionToken(token);

  if (!session) redirect('/login');
  if (!allowedRoles.includes(session.role)) redirect('/');

  return session;
}

/** Guarda de las páginas del backoffice: solo administradores. */
export async function requireAdminPage(): Promise<SessionPayload> {
  return requireRolePage(['admin']);
}
