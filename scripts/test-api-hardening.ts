/**
 * Pruebas del endurecimiento de query params, búsqueda y rate limit.
 *
 * No requieren base de datos: validan los schemas, la construcción de filtros,
 * el recorte de tokens y el store de rate limit en memoria.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_LIST_SEARCH_LENGTH,
  clientListQuerySchema,
  orderListQuerySchema,
  productListQuerySchema,
} from '../lib/validations';
import { buildOrderListQuery } from '../lib/order-query';
import { MAX_SEARCH_TOKENS, buildClientSearchFilter, splitSearchTokens } from '../lib/search-query';
import {
  API_RATE_LIMIT_RULES,
  apiRateLimitKey,
  consume,
  resetApiRateLimits,
} from '../lib/api-rate-limit';
import { getClientIp, ipRateLimitKey } from '../lib/login-rate-limit';
import { resolveClientIp, UNKNOWN_CLIENT_IP } from '../lib/client-ip';

const session = {
  userId: '0000000000000000000000a1',
  username: 'admin',
  role: 'admin' as const,
};

test('los schemas acotan búsqueda, página y límite', () => {
  assert.equal(
    clientListQuerySchema.safeParse({ search: 'x'.repeat(MAX_LIST_SEARCH_LENGTH) }).success,
    true,
  );
  assert.equal(
    clientListQuerySchema.safeParse({ search: 'x'.repeat(MAX_LIST_SEARCH_LENGTH + 1) }).success,
    false,
  );
  assert.equal(
    productListQuerySchema.safeParse({ search: 'x'.repeat(MAX_LIST_SEARCH_LENGTH + 1) }).success,
    false,
  );

  const orders = orderListQuerySchema.parse({ page: '0', limit: '9999' });
  assert.equal(orders.page, 1);
  assert.equal(orders.limit, 500);

  const clients = clientListQuerySchema.parse({ page: 'abc', limit: '9999' });
  assert.equal(clients.page, 1);
  assert.equal(clients.limit, 200);

  const products = productListQuerySchema.parse({ page: '-5', limit: '0' });
  assert.equal(products.page, 1);
  assert.equal(products.limit, 1);

  assert.equal(orderListQuerySchema.parse({ limit: '50' }).limit, 50);
});

test('status valida cada token del CSV y archived sólo acepta true/false/all', () => {
  assert.equal(
    orderListQuerySchema.safeParse({ status: 'borrador,paralizado,facturacion' }).success,
    true,
  );
  assert.equal(orderListQuerySchema.safeParse({ status: 'borrador,aprobado' }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ status: 'borrador,' }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ status: '' }).success, false);

  for (const archived of ['true', 'false', 'all']) {
    assert.equal(orderListQuerySchema.safeParse({ archived }).success, true);
  }
  assert.equal(orderListQuerySchema.safeParse({ archived: '1' }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ archived: 'si' }).success, false);
});

test('las fechas aceptan ISO/YYYY-MM-DD y rechazan días o formatos inválidos', () => {
  for (const date of [
    '2026-01-31',
    '2026-01-31T10:00:00.000Z',
    '2026-01-31T10:00:00-03:00',
    '2026-01-31T10:00Z',
  ]) {
    assert.equal(
      orderListQuerySchema.safeParse({ startDate: date }).success,
      true,
      `${date} debería ser válida`,
    );
  }

  for (const date of [
    'no-es-fecha',
    '31/01/2026',
    '2026-02-30',
    '2026-13-01',
    '2026-01-31T99:00:00Z',
  ]) {
    assert.equal(
      orderListQuerySchema.safeParse({ startDate: date }).success,
      false,
      `${date} debería rechazarse`,
    );
  }
});

test('buildOrderListQuery devuelve 400 lógico ante una fecha inválida', () => {
  for (const filters of [
    { startDate: 'no-es-fecha' },
    { endDate: '2026-02-30' },
    { startDate: '2026-13-01', endDate: '2026-12-31' },
  ]) {
    assert.deepEqual(buildOrderListQuery(session, filters), {
      ok: false,
      error: 'Rango de fechas inválido',
    });
  }

  const result = buildOrderListQuery(session, {
    startDate: '2026-01-01',
    endDate: '2026-01-31',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(result.query.createdAt.$gte instanceof Date);
  assert.ok(result.query.createdAt.$lte instanceof Date);
  assert.equal(result.query.createdAt.$lte.getHours(), 23);
  assert.equal(result.query.createdAt.$lte.getMinutes(), 59);
  assert.equal(result.query.createdAt.$lte.getSeconds(), 59);
  assert.equal(result.query.createdAt.$lte.getMilliseconds(), 999);
});

test('splitSearchTokens corta en 8 tokens únicos y descarta tokens gigantes', () => {
  const nineTokens = Array.from({ length: 9 }, (_, index) => `token${index}`).join(' ');
  const tokens = splitSearchTokens(nineTokens);

  assert.ok(tokens);
  assert.equal(tokens!.length, MAX_SEARCH_TOKENS);
  assert.deepEqual(
    tokens!.map((token) => token.normalized),
    ['token0', 'token1', 'token2', 'token3', 'token4', 'token5', 'token6', 'token7'],
  );

  const fiftyTokens = Array.from({ length: 50 }, (_, index) => `t${index}`).join(' ');
  const filter = buildClientSearchFilter(fiftyTokens) as any;
  assert.ok(filter);
  assert.equal(filter.$or[0].searchTokens.$all.length, MAX_SEARCH_TOKENS);
  assert.ok(
    filter.$or[0].searchTokens.$all.every((regex: RegExp) => regex.source.length <= 42),
    'la consulta no debe arrastrar los 50 tokens',
  );

  const giant = 'a'.repeat(10_000);
  assert.equal(splitSearchTokens(giant), null);
  assert.equal(buildClientSearchFilter(giant), null);
  assert.equal(splitSearchTokens('---'), null);
});

test('consume permite N solicitudes y bloquea la N+1 con Retry-After', () => {
  resetApiRateLimits();
  const key = 'test:user:1';
  const options = { limit: 3, windowMs: 60_000 };
  const now = 1_700_000_000_000;

  for (let attempt = 0; attempt < options.limit; attempt += 1) {
    assert.equal(consume(key, options, now).allowed, true);
  }

  const blocked = consume(key, options, now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(blocked.retryAfterSeconds, 60);

  resetApiRateLimits();
});

test('las reglas de los endpoints caros quedan explícitas', () => {
  assert.equal(API_RATE_LIMIT_RULES.ordersExport.limit, 10);
  assert.equal(API_RATE_LIMIT_RULES.catalogImport.limit, 5);
  assert.equal(API_RATE_LIMIT_RULES.ordersSearch.limit, 60);
});

test('TRUST_PROXY_HEADERS=false ignora x-forwarded-for y no cambia la clave por IP', () => {
  const previous = process.env.TRUST_PROXY_HEADERS;

  try {
    process.env.TRUST_PROXY_HEADERS = 'false';

    const first = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
    });
    const second = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '198.51.100.20' },
    });

    assert.equal(getClientIp(first), UNKNOWN_CLIENT_IP);
    assert.equal(getClientIp(second), UNKNOWN_CLIENT_IP);
    assert.equal(resolveClientIp(first, 'unknown'), 'unknown');
    assert.equal(
      ipRateLimitKey(getClientIp(first)),
      ipRateLimitKey(getClientIp(second)),
      'un header arbitrario no debe cambiar la clave del límite por IP',
    );

    process.env.TRUST_PROXY_HEADERS = 'true';
    assert.equal(getClientIp(first), '203.0.113.10');
    assert.equal(getClientIp(second), '198.51.100.20');
    assert.notEqual(ipRateLimitKey(getClientIp(first)), ipRateLimitKey(getClientIp(second)));
    assert.equal(apiRateLimitKey('orders-export', 'u1'), 'orders-export:user:u1');
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = previous;
  }
});
