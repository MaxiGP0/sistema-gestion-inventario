/**
 * Pruebas del rate limiting del login y del rechazo temprano del endpoint.
 * No requieren base de datos: los casos bloqueados o inválidos se resuelven
 * antes de que la ruta intente conectarse a Mongo.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LOGIN_RATE_LIMIT,
  getClientIp,
  getRetryAfterSeconds,
  ipRateLimitKey,
  isRateLimited,
  recordFailedAttempt,
  resetAllAttempts,
  resetAttempts,
  userRateLimitKey,
} from '../lib/login-rate-limit';
import { POST as login } from '../app/api/auth/login/route';

const { maxAttempts, windowMs } = LOGIN_RATE_LIMIT;

function loginRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

test('el limitador bloquea al agotar los intentos y se libera al vencer la ventana', () => {
  const key = ipRateLimitKey('198.51.100.7');
  const now = 1_700_000_000_000;

  assert.equal(isRateLimited(key, now), false);

  for (let attempt = 0; attempt < maxAttempts - 1; attempt++) {
    recordFailedAttempt(key, now);
  }
  assert.equal(isRateLimited(key, now), false, 'debajo del máximo no debe bloquear');

  recordFailedAttempt(key, now);
  assert.equal(isRateLimited(key, now), true, 'al llegar al máximo debe bloquear');
  assert.equal(getRetryAfterSeconds(key, now), Math.ceil(windowMs / 1000));
  assert.equal(getRetryAfterSeconds(key, now + 60_000), Math.ceil((windowMs - 60_000) / 1000));

  assert.equal(isRateLimited(key, now + windowMs), false, 'al vencer la ventana debe liberarse');
});

test('las claves de IP y usuario son independientes y el usuario se normaliza', () => {
  const now = 1_700_000_000_000;
  const blockedUserKey = userRateLimitKey('admin');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    recordFailedAttempt(blockedUserKey, now);
  }

  assert.equal(isRateLimited(blockedUserKey, now), true);
  assert.equal(isRateLimited(ipRateLimitKey('198.51.100.9'), now), false);
  assert.equal(isRateLimited(userRateLimitKey('otro-usuario'), now), false);

  assert.equal(userRateLimitKey('  Admin '), blockedUserKey, 'el usuario debe normalizarse');
});

test('resetAttempts desbloquea la clave', () => {
  const key = ipRateLimitKey('198.51.100.10');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    recordFailedAttempt(key);
  }
  assert.equal(isRateLimited(key), true);

  resetAttempts(key);
  assert.equal(isRateLimited(key), false);
});

test('getClientIp prioriza x-forwarded-for y cae a x-real-ip o desconocida', () => {
  const forwarded = new Request('http://localhost', {
    headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
  });
  assert.equal(getClientIp(forwarded), '203.0.113.1');

  const realIp = new Request('http://localhost', { headers: { 'x-real-ip': '203.0.113.2' } });
  assert.equal(getClientIp(realIp), '203.0.113.2');

  assert.equal(getClientIp(new Request('http://localhost')), 'desconocida');
});

test('POST /api/auth/login responde 429 con Retry-After cuando la IP está bloqueada', async () => {
  resetAllAttempts();
  const ip = '203.0.113.50';
  const ipKey = ipRateLimitKey(ip);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    recordFailedAttempt(ipKey);
  }

  const response = await login(
    loginRequest(JSON.stringify({ username: 'admin', password: 'incorrecta' }), {
      'x-forwarded-for': ip,
    }),
  );

  assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(
    retryAfter > 0 && retryAfter <= Math.ceil(windowMs / 1000),
    `Retry-After fuera de rango: ${retryAfter}`,
  );

  const payload = await response.json();
  assert.ok(payload.error, 'la respuesta debe incluir un mensaje de error');

  resetAllAttempts();
});

test('POST /api/auth/login responde 429 cuando el usuario está bloqueado, aunque la IP sea nueva', async () => {
  resetAllAttempts();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    recordFailedAttempt(userRateLimitKey('Admin'));
  }

  const response = await login(
    loginRequest(JSON.stringify({ username: ' admin ', password: 'incorrecta' }), {
      'x-forwarded-for': '203.0.113.51',
    }),
  );

  assert.equal(response.status, 429);
  resetAllAttempts();
});

test('POST /api/auth/login rechaza cuerpos inválidos con 400 sin conectarse a Mongo', async () => {
  resetAllAttempts();

  const malformed = await login(loginRequest('{esto-no-es-json'));
  assert.equal(malformed.status, 400);

  const missingPassword = await login(loginRequest(JSON.stringify({ username: 'admin' })));
  assert.equal(missingPassword.status, 400);

  const wrongTypes = await login(loginRequest(JSON.stringify({ username: 123, password: true })));
  assert.equal(wrongTypes.status, 400);

  const emptyBody = await login(loginRequest(''));
  assert.equal(emptyBody.status, 400);

  resetAllAttempts();
});
