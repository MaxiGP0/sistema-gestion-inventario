/**
 * Guardas de autenticación/autorización para los route handlers.
 *
 * El proxy ya exige sesión, pero cada ruta vuelve a verificar la cookie
 * firmada (defensa en profundidad: el handler puede invocarse en tests o
 * desde otro contexto sin pasar por el proxy).
 *
 * `requireSession` y `requireRole` se resuelven solo con las claims firmadas
 * (sin tocar Mongo), así que un 401/403 básico nunca depende de la base. Las
 * escrituras, las lecturas sensibles y las páginas usan `requireCurrentSession`
 * / `requireCurrentRolePage`, que leen `active`, `sessionVersion` y `role`
 * actuales (con caché corto) para que una baja, un cambio de rol o un reset de
 * contraseña invaliden la sesión sin esperar 8 h.
 */

import { cookies } from 'next/headers';
import { NextResponse, connection } from 'next/server';
import dbConnect from './mongodb';
import { User } from '@/models/User';
import { normalizeUserRole, resolveUserRole, type UserRole } from './authz';
import {
  getCachedCurrentSession,
  invalidateCurrentSessionCache,
  primeCurrentSessionCache,
  type CurrentSessionSnapshot,
} from './current-session-cache';
import {
  clearSessionCookies,
  readCookieFromRequest,
  readSessionToken,
  verifySessionToken,
  type SessionPayload,
} from './session';
import type { AuthUserDTO } from './types';

export interface AuthSuccess {
  session: SessionPayload;
  /** Estado actual leído de la base; solo lo completa requireCurrentSession. */
  currentUser?: CurrentSessionSnapshot;
}

export interface AuthFailure {
  response: NextResponse;
}

export type AuthResult = AuthSuccess | AuthFailure;

export function unauthorizedResponse(message = 'Sesión requerida'): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function forbiddenResponse(message = 'No autorizado para esta operación'): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}

/** Borra la cookie de sesión en la respuesta dada (por ejemplo, token vencido). */
export function clearSessionCookie(response: NextResponse): NextResponse {
  clearSessionCookies(response);
  return response;
}

/** Sesión firmada del request, o `null` si no hay cookie válida. */
export function getRequestSession(request: Request): SessionPayload | null {
  const token = readSessionToken((name) => readCookieFromRequest(request, name));
  return verifySessionToken(token);
}

/** Exige una sesión válida. */
export function requireSession(request: Request): AuthResult {
  const session = getRequestSession(request);
  if (!session) return { response: unauthorizedResponse() };

  return { session };
}

/** Exige una sesión válida con uno de los roles permitidos. */
export function requireRole(request: Request, allowedRoles: readonly UserRole[]): AuthResult {
  const result = requireSession(request);
  if ('response' in result) return result;

  if (!allowedRoles.includes(result.session.role)) {
    return { response: forbiddenResponse() };
  }

  return result;
}

interface LeanCurrentUser {
  username?: string;
  role?: unknown;
  active?: boolean;
  sessionVersion?: number;
  notificationsEnabled?: boolean;
}

/**
 * Lee el estado actual del usuario con una proyección mínima y lo cachea
 * 30-60 s. No cachea usuarios inexistentes: si el documento se borra, la
 * siguiente petición vuelve a consultar y cierra la sesión.
 */
async function loadCurrentUser(userId: string): Promise<CurrentSessionSnapshot | null> {
  const cached = getCachedCurrentSession(userId);
  if (cached) return cached;

  await dbConnect();

  const user = await User.findById(userId)
    .select('username role active sessionVersion notificationsEnabled')
    .lean<LeanCurrentUser | null>();

  if (!user) return null;

  return primeCurrentSessionCache({
    userId,
    username: user.username ?? '',
    role: normalizeUserRole(user.role) ?? resolveUserRole(user.role, user.username),
    active: user.active !== false,
    sessionVersion:
      typeof user.sessionVersion === 'number' && Number.isInteger(user.sessionVersion)
        ? user.sessionVersion
        : 0,
    notificationsEnabled: user.notificationsEnabled !== false,
  });
}

function staleSessionResponse(): NextResponse {
  return clearSessionCookie(unauthorizedResponse('Sesión inválida o vencida'));
}

/**
 * Contrasta una sesión firmada con el estado actual del usuario.
 *
 * Devuelve el snapshot vigente o `null` si el usuario no existe, está inactivo
 * o su `sessionVersion` cambió. Comparte la caché de 30-60 s con
 * `requireCurrentSession` y `requireCurrentRolePage`, así que las páginas y las
 * lecturas aplican una baja/cambio de rol con el mismo costo que una escritura.
 */
export async function resolveCurrentSessionUser(
  signed: SessionPayload,
): Promise<CurrentSessionSnapshot | null> {
  const currentUser = await loadCurrentUser(signed.userId);

  if (!currentUser || !currentUser.active || currentUser.sessionVersion !== signed.sessionVersion) {
    if (!currentUser) invalidateCurrentSessionCache(signed.userId);
    return null;
  }

  return currentUser;
}

/**
 * Sesión firmada + estado actual del usuario.
 *
 * Devuelve 401 y borra la cookie si el usuario ya no existe, fue desactivado o
 * su `sessionVersion` no coincide con la firmada. El rol que retorna es el de
 * la base, no el de la cookie: un cambio de rol rige de inmediato.
 */
export async function requireCurrentSession(request: Request): Promise<AuthResult> {
  const signed = getRequestSession(request);
  if (!signed) return { response: unauthorizedResponse() };

  const currentUser = await resolveCurrentSessionUser(signed);
  if (!currentUser) return { response: staleSessionResponse() };

  return {
    session: {
      ...signed,
      username: currentUser.username || signed.username,
      role: currentUser.role,
      sessionVersion: currentUser.sessionVersion,
    },
    currentUser,
  };
}

/** Exige sesión actual y uno de los roles permitidos (para escrituras). */
export async function requireCurrentRole(
  request: Request,
  allowedRoles: readonly UserRole[],
): Promise<AuthResult> {
  const result = await requireCurrentSession(request);
  if ('response' in result) return result;

  if (!allowedRoles.includes(result.session.role)) {
    return { response: forbiddenResponse() };
  }

  return result;
}

/**
 * Resuelve el usuario para hidratar el `UserProvider` **sin consultar Mongo**.
 *
 * La cookie firmada ya trae `userId`, `username`, `role` y `sessionVersion`.
 * Si el snapshot del usuario está en el caché en memoria (el login y
 * `requireCurrentSession` lo priman, y las mutaciones lo invalidan), se usa ese
 * estado más fresco y se respetan `active`/`sessionVersion`. Si no está en
 * memoria, se devuelven las propias claims firmadas: el layout raíz no espera
 * una conexión/consulta a la base antes de transmitir el skeleton de la ruta.
 *
 * Esto hidrata sólo identidad/UI. La autorización real sigue en
 * `requireRolePage` (páginas), `requireCurrentSession` (escrituras) y
 * `/api/auth/session`, que sí contrastan el estado actual contra Mongo.
 *
 * Devuelve `null` si no hay sesión firmada válida o si el snapshot cacheado
 * indica que el usuario fue desactivado o su versión cambió.
 */
export function resolveBootstrapSessionUser(
  signed: SessionPayload | null,
  cached: CurrentSessionSnapshot | null = null,
): AuthUserDTO | null {
  if (!signed) return null;

  if (cached) {
    if (!cached.active || cached.sessionVersion !== signed.sessionVersion) return null;

    return {
      id: signed.userId,
      username: cached.username || signed.username,
      role: cached.role,
      notificationsEnabled: cached.notificationsEnabled !== false,
    };
  }

  return {
    id: signed.userId,
    username: signed.username,
    role: signed.role,
    notificationsEnabled: true,
  };
}

/**
 * Versión rápida de `getInitialSessionUser` para el layout raíz: verifica la
 * firma de la cookie y, si ya está en memoria, usa el caché de sesión. No hace
 * `dbConnect()` ni `User.findById()`, así que nunca bloquea el primer chunk con
 * una espera de base de datos.
 */
export async function getInitialSessionUserFast(): Promise<AuthUserDTO | null> {
  // Sin `connection()`, Cache Components intentaría prerenderizar la lectura
  // de `Date.now()`/cookies como si fuera estática.
  await connection();

  const cookieStore = await cookies();
  const token = readSessionToken((name) => cookieStore.get(name)?.value);
  const signed = verifySessionToken(token);

  if (!signed) return null;

  return resolveBootstrapSessionUser(signed, getCachedCurrentSession(signed.userId));
}

/**
 * Usuario de la sesión para el primer render del layout raíz, con validación
 * completa contra Mongo.
 *
 * Se conserva para `/login`, que necesita saber con certeza si el usuario sigue
 * activo antes de redirigir. El layout raíz usa `getInitialSessionUserFast`
 * para no retrasar el streaming con esta consulta.
 *
 * No redirige: el proxy ya exige sesión. Devuelve `null` cuando no hay cookie
 * válida o cuando el usuario fue desactivado/eliminado o cambió su versión.
 */
export async function getInitialSessionUser(): Promise<AuthUserDTO | null> {
  // La verificación compara el vencimiento contra `Date.now()`: sin esto el
  // build intenta prerenderizar la lectura como si fuera estática.
  await connection();

  const cookieStore = await cookies();
  const token = readSessionToken((name) => cookieStore.get(name)?.value);
  const signed = verifySessionToken(token);

  if (!signed) return null;

  const currentUser = await loadCurrentUser(signed.userId);

  if (!currentUser || !currentUser.active || currentUser.sessionVersion !== signed.sessionVersion) {
    if (!currentUser) invalidateCurrentSessionCache(signed.userId);
    return null;
  }

  return {
    id: signed.userId,
    username: currentUser.username || signed.username,
    role: currentUser.role,
    notificationsEnabled: currentUser.notificationsEnabled !== false,
  };
}
