/**
 * Sesión sin dependencias externas: cookie httpOnly firmada con HMAC SHA-256
 * usando AUTH_SECRET.
 *
 * Formato del token: `base64url(payload).base64url(HMAC-SHA256(payload))`,
 * donde payload es `{ userId, username, role, sessionVersion, iat, exp }`.
 * La verificación compara firmas con timingSafeEqual y valida forma y
 * vencimiento. Las sesiones emitidas antes de incorporar `sessionVersion` se
 * aceptan como versión 0 para no cerrar sesiones al desplegar.
 *
 * La cookie por sí sola no alcanza para autorizar escrituras: los route
 * handlers de escritura usan `requireCurrentSession` (lib/auth.ts), que
 * contrasta `active`, `role` y `sessionVersion` contra la base.
 *
 * Este módulo es la única pieza que toca node:crypto; corre en el runtime
 * Node (proxy/route handlers). Para datos compartidos con el cliente usar
 * lib/authz.ts, que es puro.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUserRole, normalizeUserRole, type UserRole } from './authz';
import { AUTH_SECRET_MIN_LENGTH } from './env';

/**
 * Nombre histórico/sin prefijo. Se sigue leyendo para no cerrar sesiones al
 * desplegar el cambio y se usa en desarrollo, donde `__Host-` no aplica porque
 * el servidor local no siempre habla HTTPS.
 */
export const SESSION_COOKIE_NAME = 'sgi_session';

/**
 * En producción la cookie lleva el prefijo `__Host-`: obliga a `Secure`,
 * `Path=/` y prohíbe `Domain`, así que sólo el host exacto puede leerla ni
 * fijarla desde un subdominio.
 */
export const SESSION_COOKIE_NAME_PRODUCTION = '__Host-sgi_session';

/** Duración de la sesión: una jornada laboral. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionClaims {
  userId: string;
  username: string;
  role: UserRole;
  /** Versión del usuario al emitir la sesión; 0 en tokens históricos. */
  sessionVersion: number;
}

export interface SessionPayload extends SessionClaims {
  /** Emitido en (segundos Unix). */
  iat: number;
  /** Vence en (segundos Unix). */
  exp: number;
}

/**
 * Secreto de firma. Falla con un mensaje claro en vez de firmar con un
 * valor vacío (eso permitiría falsificar sesiones).
 */
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;

  if (!secret || secret.trim().length < AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `AUTH_SECRET no está configurado o es demasiado corto (mínimo ${AUTH_SECRET_MIN_LENGTH} caracteres). Definilo en .env.local.`,
    );
  }

  return secret;
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getAuthSecret()).update(encodedPayload).digest('base64url');
}

/** Emite un token firmado para las claims dadas. */
export function createSessionToken(claims: SessionClaims, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = {
    ...claims,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

function isSessionPayloadShape(value: unknown): value is Omit<
  SessionPayload,
  'role' | 'sessionVersion'
> & {
  role: unknown;
  sessionVersion?: unknown;
} {
  if (typeof value !== 'object' || value === null) return false;

  const payload = value as Record<string, unknown>;
  return (
    typeof payload.userId === 'string' &&
    payload.userId.length > 0 &&
    typeof payload.username === 'string' &&
    payload.username.length > 0 &&
    'role' in payload &&
    (payload.sessionVersion === undefined ||
      (typeof payload.sessionVersion === 'number' &&
        Number.isInteger(payload.sessionVersion) &&
        payload.sessionVersion >= 0)) &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number'
  );
}

/**
 * Verifica firma, forma y vencimiento. Devuelve las claims o `null` si el
 * token es inválido (falsificado, corrupto o vencido). Si falta AUTH_SECRET
 * lanza: es un error de configuración, no un token inválido.
 */
export function verifySessionToken(
  token: string | undefined | null,
  now = Date.now(),
): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  const expected = Buffer.from(signPayload(encodedPayload), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!isSessionPayloadShape(payload)) return null;
  if (payload.exp * 1000 <= now) return null;

  // Las sesiones emitidas antes del rename pueden llevar `deposit`: se
  // normalizan a `controlador` sin obligar al usuario a volver a loguearse.
  const role = normalizeUserRole(payload.role);
  if (!isUserRole(role)) return null;

  // Los tokens anteriores a `sessionVersion` equivalen a la versión 0.
  const sessionVersion = typeof payload.sessionVersion === 'number' ? payload.sessionVersion : 0;

  return { ...payload, role, sessionVersion };
}

/** Nombre vigente de la cookie; en producción usa el prefijo `__Host-`. */
export function sessionCookieName(isProduction = process.env.NODE_ENV === 'production'): string {
  return isProduction ? SESSION_COOKIE_NAME_PRODUCTION : SESSION_COOKIE_NAME;
}

/**
 * Nombres que se aceptan al leer y se limpian al cerrar sesión. En producción
 * se incluye el nombre legacy para migrar sin desloguear a los usuarios que
 * todavía tengan la cookie vieja.
 */
export function sessionCookieNames(isProduction = process.env.NODE_ENV === 'production'): string[] {
  return isProduction
    ? [SESSION_COOKIE_NAME_PRODUCTION, SESSION_COOKIE_NAME]
    : [SESSION_COOKIE_NAME];
}

/**
 * Opciones de la cookie de sesión. En producción `Secure` es obligatorio para
 * que el navegador acepte el prefijo `__Host-`; nunca se envía `Domain`.
 */
export function sessionCookieOptions(isProduction = process.env.NODE_ENV === 'production') {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** Datos completos de la cookie a escribir tras un login o cambio de clave. */
export function buildSessionCookie(
  token: string,
  isProduction = process.env.NODE_ENV === 'production',
) {
  return {
    name: sessionCookieName(isProduction),
    value: token,
    options: sessionCookieOptions(isProduction),
  };
}

/** Respuesta mínima con `cookies.set`, compatible con NextResponse. */
export interface CookieResponseLike {
  cookies: {
    set(name: string, value: string, options: ReturnType<typeof sessionCookieOptions>): unknown;
  };
}

/** Borra todas las variantes conocidas de la cookie (incluida la legacy). */
export function clearSessionCookies(
  response: CookieResponseLike,
  isProduction = process.env.NODE_ENV === 'production',
): void {
  for (const name of sessionCookieNames(isProduction)) {
    response.cookies.set(name, '', { ...sessionCookieOptions(isProduction), maxAge: 0 });
  }
}

/**
 * Busca el token probando primero el nombre vigente y luego el legacy. El
 * getter abstrae `NextRequest.cookies` y `cookies()` de `next/headers`.
 */
export function readSessionToken(
  getCookie: (name: string) => string | undefined,
  isProduction = process.env.NODE_ENV === 'production',
): string | undefined {
  for (const name of sessionCookieNames(isProduction)) {
    const token = getCookie(name);
    if (token) return token;
  }

  return undefined;
}

/** Lee una cookie del header `Cookie` de un Request estándar. */
export function readCookieFromRequest(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = part.slice(0, separatorIndex).trim();
    if (key !== name) continue;

    const rawValue = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}
