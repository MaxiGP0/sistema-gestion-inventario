/**
 * Proxy de autenticación (Next.js 16 renombró `middleware.ts` a `proxy.ts`;
 * el runtime por defecto es Node, así que puede usar node:crypto vía
 * lib/session.ts).
 *
 * Exige sesión firmada en todas las páginas y en `/api/*`, salvo:
 * - `/login` y `/api/auth/login` (públicos)
 * - `/api/health` (probe de infraestructura, sin datos de negocio)
 * - estáticos (`_next/**`, imágenes, fuentes, manifest, etc.)
 *
 * `/api/events` (SSE de notificaciones) ya no es público: el handler deriva la
 * bandeja del rol de la sesión y no acepta un query del cliente.
 *
 * Además propaga un `x-request-id` a la ruta y a la respuesta para que los
 * logs estructurados de cada handler puedan correlacionarse.
 *
 * Además, aplica la regla de navegación por rol (canAccessPage): cada rol
 * solo entra a sus bandejas. La autorización fina de cada operación se
 * vuelve a chequear en el route handler correspondiente.
 *
 * Antes de todo eso rechaza (403) las mutaciones de `/api/*` con `Origin` de
 * otro host o `Sec-Fetch-Site: cross-site`. La cookie de sesión se lee con
 * `readSessionToken`, que en producción acepta `__Host-sgi_session` y la
 * variante legacy `sgi_session` durante la migración.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { canAccessPage } from '@/lib/authz';
import { REQUEST_ID_HEADER, attachRequestId, logError, resolveRequestId } from '@/lib/logger';
import { captureServerError } from '@/lib/observability/errors-server';
import { clearSessionCookies, readSessionToken, verifySessionToken } from '@/lib/session';

const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/health',
  // Shell offline estático: no contiene sesión ni datos de negocio y debe
  // poder mostrarse aunque la cookie haya vencido o no haya red.
  '/offline',
  '/offline.html',
]);

const STATIC_FILE_PATTERN =
  /\.(?:css|js|mjs|map|json|txt|xml|html|ico|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot|webmanifest)$/i;

/** Métodos que pueden cambiar estado y, por lo tanto, requieren chequeo CSRF. */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function firstHeaderValue(value: string | null): string | undefined {
  const first = value?.split(',')[0]?.trim();
  return first ? first.toLowerCase() : undefined;
}

/** Host efectivo del request, respetando el proxy inverso. */
function resolveRequestHost(request: NextRequest): string | undefined {
  const rawHost =
    firstHeaderValue(request.headers.get('x-forwarded-host')) ??
    firstHeaderValue(request.headers.get('host')) ??
    request.nextUrl.host;

  if (!rawHost) return undefined;

  try {
    return new URL(`http://${rawHost}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** `Origin` ausente no se rechaza acá: los clientes no-browser no lo envían. */
function originMatchesRequestHost(request: NextRequest, origin: string): boolean {
  const requestHost = resolveRequestHost(request);
  if (!requestHost || !origin || origin === 'null') return false;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

/**
 * Rechaza mutaciones de `/api/*` con `Origin` de otro host o marcadas como
 * cross-site. `Sec-Fetch-Site` cubre navegadores que no mandan `Origin`.
 */
function isCrossOriginMutation(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith('/api/')) return false;
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return false;

  if (request.headers.get('sec-fetch-site')?.trim().toLowerCase() === 'cross-site') {
    return true;
  }

  const origin = request.headers.get('origin');
  if (!origin) return false;

  return !originMatchesRequestHost(request, origin);
}

/** Quita la barra final para comparar rutas ("/login/" === "/login"). */
function normalizePathname(pathname: string): string {
  if (pathname.length <= 1) return pathname;
  return pathname.replace(/\/+$/, '') || '/';
}

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    STATIC_FILE_PATTERN.test(pathname)
  );
}

/** Redirige al login y limpia la cookie inválida/vencida. */
function redirectToLogin(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url));
  clearSessionCookies(response);
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const normalizedPath = normalizePathname(pathname);
  const requestId = resolveRequestId(request);

  /** `next()` reenviando el request-id a la ruta. */
  const next = () => {
    const headers = new Headers(request.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return NextResponse.next({ request: { headers } });
  };

  if (isCrossOriginMutation(request)) {
    return attachRequestId(
      NextResponse.json({ error: 'Origen no permitido' }, { status: 403 }),
      requestId,
    );
  }

  if (isStaticAsset(pathname) || PUBLIC_PATHS.has(normalizedPath)) {
    return attachRequestId(next(), requestId);
  }

  let session = null;
  try {
    const token = readSessionToken((name) => request.cookies.get(name)?.value);
    session = verifySessionToken(token);
  } catch (error) {
    // AUTH_SECRET mal configurado: fallar cerrado y avisar en los logs.
    logError('proxy.session_verification_failed', error, { requestId, path: pathname });
    captureServerError(error, {
      requestId,
      route: pathname,
      method: request.method,
      status: 500,
      context: 'proxy.session_verification_failed',
    });
    return attachRequestId(
      NextResponse.json({ error: 'Error de configuración de autenticación' }, { status: 500 }),
      requestId,
    );
  }

  const isApiRequest = normalizedPath.startsWith('/api/');

  if (!session) {
    if (isApiRequest) {
      const response = NextResponse.json({ error: 'Sesión requerida' }, { status: 401 });
      clearSessionCookies(response);
      return attachRequestId(response, requestId);
    }

    return attachRequestId(redirectToLogin(request), requestId);
  }

  // Las APIs validan el rol fino en cada handler; acá solo se exige sesión.
  if (!isApiRequest && !canAccessPage(normalizedPath, session.role)) {
    return attachRequestId(NextResponse.redirect(new URL('/', request.url)), requestId);
  }

  return attachRequestId(next(), requestId);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
