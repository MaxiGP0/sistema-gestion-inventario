/**
 * Pruebas de las cabeceras de seguridad, el chequeo CSRF por Origin y la
 * cookie `__Host-` de producción.
 *
 * No requieren base de datos ni servidor: `proxy()` y las funciones puras de
 * `lib/session.ts` alcanzan para verificar los rechazos y el formato de la
 * cookie.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NextRequest } from 'next/server';

import {
  HSTS_VALUE,
  PERMISSIONS_POLICY_VALUE,
  buildSecurityHeaders,
} from '../lib/security-headers';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_PRODUCTION,
  SESSION_TTL_SECONDS,
  buildSessionCookie,
  clearSessionCookies,
  readSessionToken,
  sessionCookieName,
  sessionCookieNames,
  sessionCookieOptions,
} from '../lib/session';
import { proxy } from '../proxy';
import { testSessionCookie } from './test-auth-utils';

function headersToMap(headers: ReturnType<typeof buildSecurityHeaders>): Map<string, string> {
  return new Map(headers.map(({ key, value }) => [key, value]));
}

const mutationRequest = (
  path: string,
  headers: Record<string, string>,
  method = 'POST',
): NextRequest => new NextRequest(`http://localhost${path}`, { method, headers });

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('los headers de seguridad están presentes en desarrollo', () => {
  const headers = headersToMap(buildSecurityHeaders(false));

  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
  assert.equal(headers.get('Permissions-Policy'), PERMISSIONS_POLICY_VALUE);

  const csp = headers.get('Content-Security-Policy-Report-Only');
  assert.ok(csp, 'debe enviarse la CSP en Report-Only');
  assert.ok(!headers.has('Content-Security-Policy'), 'todavía no debe aplicarse la CSP');
  assert.ok(!headers.has('Strict-Transport-Security'), 'HSTS no aplica fuera de producción');

  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /script-src[^;]*'unsafe-eval'/, 'dev necesita eval para React');
  assert.match(csp, /connect-src[^;]*ws:/, 'dev necesita WebSocket para HMR');
  assert.doesNotMatch(csp, /[\r\n]/, 'la CSP debe ser una sola línea');
});

test('en producción se agrega HSTS y se endurece la CSP', () => {
  const headers = headersToMap(buildSecurityHeaders(true));

  assert.equal(headers.get('Strict-Transport-Security'), HSTS_VALUE);

  const csp = headers.get('Content-Security-Policy-Report-Only') ?? '';
  assert.match(csp, /upgrade-insecure-requests/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.doesNotMatch(csp, /connect-src[^;]*ws:/);
});

// ---------------------------------------------------------------------------
// CSRF por Origin / Sec-Fetch-Site
// ---------------------------------------------------------------------------

test('el proxy rechaza mutaciones /api con Origin de otro host', async () => {
  const response = proxy(
    mutationRequest('/api/auth/login', {
      origin: 'https://evil.example',
      'content-type': 'application/json',
    }),
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Origen no permitido' });

  const withSession = proxy(
    mutationRequest('/api/orders', {
      origin: 'https://evil.example',
      cookie: testSessionCookie('vendedor'),
    }),
  );
  assert.equal(withSession.status, 403, 'también debe rechazar con sesión válida');
});

test('el proxy rechaza Sec-Fetch-Site cross-site aunque no venga Origin', () => {
  const response = proxy(
    mutationRequest('/api/orders', {
      'sec-fetch-site': 'cross-site',
      cookie: testSessionCookie('vendedor'),
    }),
  );

  assert.equal(response.status, 403);
});

test('el proxy acepta mutaciones del mismo host y peticiones no mutantes', () => {
  const sameOrigin = proxy(
    mutationRequest('/api/auth/login', {
      origin: 'http://localhost',
      'content-type': 'application/json',
    }),
  );
  assert.equal(sameOrigin.headers.get('x-middleware-next'), '1');

  // Detrás de un proxy inverso el host efectivo puede venir en x-forwarded-host.
  const forwardedHost = proxy(
    mutationRequest(
      '/api/orders',
      {
        origin: 'https://inventario.example.com.ar',
        'x-forwarded-host': 'inventario.example.com.ar',
        cookie: testSessionCookie('vendedor'),
      },
      'PUT',
    ),
  );
  assert.equal(forwardedHost.headers.get('x-middleware-next'), '1');

  // Un GET cross-site no es una mutación: sigue rigiéndose por la sesión.
  const getCrossSite = proxy(
    new NextRequest('http://localhost/api/orders', {
      headers: {
        'sec-fetch-site': 'cross-site',
        cookie: testSessionCookie('vendedor'),
      },
    }),
  );
  assert.equal(getCrossSite.headers.get('x-middleware-next'), '1');

  // Un cliente no-browser sin Origin (p. ej. curl) no se bloquea por CSRF.
  const withoutOrigin = proxy(
    mutationRequest('/api/orders', { cookie: testSessionCookie('vendedor') }),
  );
  assert.equal(withoutOrigin.headers.get('x-middleware-next'), '1');
});

// ---------------------------------------------------------------------------
// Cookie __Host- en producción
// ---------------------------------------------------------------------------

test('la cookie cambia a __Host- en producción con Secure, Path=/ y sin Domain', () => {
  assert.equal(sessionCookieName(false), SESSION_COOKIE_NAME);
  assert.equal(sessionCookieName(true), SESSION_COOKIE_NAME_PRODUCTION);
  assert.equal(SESSION_COOKIE_NAME_PRODUCTION, '__Host-sgi_session');

  const cookie = buildSessionCookie('token-de-prueba', true);
  assert.equal(cookie.name, SESSION_COOKIE_NAME_PRODUCTION);
  assert.equal(cookie.value, 'token-de-prueba');

  const options = cookie.options as Record<string, unknown>;
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.path, '/');
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.maxAge, SESSION_TTL_SECONDS);
  assert.ok(!('domain' in options), 'la cookie no debe llevar Domain');
});

test('en producción se lee la cookie nueva y también la legacy', () => {
  const both = {
    [SESSION_COOKIE_NAME_PRODUCTION]: 'token-nuevo',
    [SESSION_COOKIE_NAME]: 'token-viejo',
  };

  assert.equal(
    readSessionToken((name) => both[name as keyof typeof both], true),
    'token-nuevo',
    'el nombre __Host- tiene prioridad',
  );

  assert.equal(
    readSessionToken((name) => (name === SESSION_COOKIE_NAME ? 'token-viejo' : undefined), true),
    'token-viejo',
    'una cookie legacy debe seguir sirviendo durante la migración',
  );

  assert.deepEqual(sessionCookieNames(true), [SESSION_COOKIE_NAME_PRODUCTION, SESSION_COOKIE_NAME]);
  assert.deepEqual(sessionCookieNames(false), [SESSION_COOKIE_NAME]);
});

test('logout limpia las dos variantes de la cookie en producción', () => {
  const writes: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  clearSessionCookies(
    {
      cookies: {
        set(name, value, options) {
          writes.push({ name, value, options: options as unknown as Record<string, unknown> });
          return undefined;
        },
      },
    },
    true,
  );

  assert.deepEqual(
    writes.map((write) => write.name),
    [SESSION_COOKIE_NAME_PRODUCTION, SESSION_COOKIE_NAME],
  );

  for (const write of writes) {
    assert.equal(write.value, '');
    assert.equal(write.options.maxAge, 0);
    assert.equal(write.options.secure, true);
    assert.equal(write.options.path, '/');
    assert.ok(!('domain' in write.options));
  }
});

test('las opciones de la cookie de desarrollo no fuerzan Secure', () => {
  const options = sessionCookieOptions(false) as Record<string, unknown>;
  assert.equal(options.secure, false);
  assert.equal(options.httpOnly, true);
  assert.equal(options.path, '/');
  assert.ok(!('domain' in options));
});
