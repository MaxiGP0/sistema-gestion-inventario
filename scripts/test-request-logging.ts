/**
 * Pruebas del logging estructurado y del request-id:
 * - `withRouteLogging` registra una línea JSON con requestId, método, ruta,
 *   status y duración, y devuelve el id en la respuesta.
 * - Respeta un `x-request-id` válido y genera uno seguro si falta o es inválido.
 * - Los errores de `handleRouteError` quedan correlacionados por requestId.
 * - El proxy propaga el id hacia la ruta y la respuesta.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';

import { handleRouteError } from '../lib/api-errors';
import { REQUEST_ID_HEADER, getRequestContext, withRouteLogging } from '../lib/logger';
import { proxy } from '../proxy';

type CapturedLog = Record<string, any>;

function captureConsole(method: 'log' | 'warn' | 'error') {
  const entries: CapturedLog[] = [];
  const original = console[method];

  console[method] = (...args: unknown[]) => {
    assert.equal(args.length, 1, 'el logger debe emitir una única línea JSON');
    entries.push(JSON.parse(String(args[0])));
  };

  return {
    entries,
    restore: () => {
      console[method] = original;
    },
  };
}

test('withRouteLogging registra el request y devuelve el request-id', async (t) => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const captured = captureConsole('log');

  t.after(() => {
    captured.restore();
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  const handler = withRouteLogging(async () => {
    assert.equal(getRequestContext()?.requestId, 'req-12345678');
    return Response.json({ ok: true });
  });

  const response = await handler(
    new Request('http://localhost/api/test?token=no-debe-loguearse', {
      headers: { [REQUEST_ID_HEADER]: 'req-12345678' },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get(REQUEST_ID_HEADER), 'req-12345678');
  assert.equal(captured.entries.length, 1);

  const entry = captured.entries[0];
  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'request.completed');
  assert.equal(entry.requestId, 'req-12345678');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.path, '/api/test');
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.durationMs, 'number');
  assert.ok(
    !JSON.stringify(entry).includes('no-debe-loguearse'),
    'no se debe loguear el query string',
  );
});

test('genera un request-id cuando falta o no es seguro', async (t) => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'silent';
  t.after(() => {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  const handler = withRouteLogging(async () => Response.json({ ok: true }));

  const missing = await handler(new Request('http://localhost/api/test'));
  const generated = missing.headers.get(REQUEST_ID_HEADER);
  assert.match(generated ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const invalid = await handler(
    new Request('http://localhost/api/test', {
      headers: { [REQUEST_ID_HEADER]: 'id con espacios' },
    }),
  );
  assert.notEqual(invalid.headers.get(REQUEST_ID_HEADER), 'id con espacios');
});

test('un handler que lanza queda logueado con su request-id', async (t) => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'error';
  const captured = captureConsole('error');

  t.after(() => {
    captured.restore();
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  const handler = withRouteLogging(async () => {
    throw new Error('fallo inesperado');
  });

  await assert.rejects(
    handler(
      new Request('http://localhost/api/test', {
        headers: { [REQUEST_ID_HEADER]: 'req-error-123' },
      }),
    ),
    /fallo inesperado/,
  );

  const failed = captured.entries.find((entry) => entry.message === 'request.failed');
  assert.ok(failed, 'debe registrar request.failed');
  assert.equal(failed.requestId, 'req-error-123');
  assert.equal(failed.error.message, 'fallo inesperado');

  const completed = captured.entries.find((entry) => entry.message === 'request.completed');
  assert.ok(completed, 'debe registrar la finalización en 500');
  assert.equal(completed.status, 500);
});

test('handleRouteError comparte el request-id del handler', async (t) => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'error';
  const captured = captureConsole('error');

  t.after(() => {
    captured.restore();
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  const handler = withRouteLogging(async () =>
    handleRouteError(new Error('mongo caído'), { context: 'Error de prueba:' }),
  );

  const response = await handler(
    new Request('http://localhost/api/test', {
      headers: { [REQUEST_ID_HEADER]: 'req-handle-123' },
    }),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Error interno del servidor' });

  const entry = captured.entries.find((item) => item.message === 'Error de prueba:');
  assert.ok(entry, 'debe registrar el error con el contexto de la ruta');
  assert.equal(entry.requestId, 'req-handle-123');
  assert.equal(entry.error.message, 'mongo caído');
});

test('withRouteLogging conserva el contexto de params de Next', async (t) => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'silent';
  t.after(() => {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  const handler = withRouteLogging(
    async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
      const { id } = await params;
      return Response.json({ id });
    },
  );

  const response = await handler(
    new Request('http://localhost/api/items/abc', {
      headers: { [REQUEST_ID_HEADER]: 'req-params-123' },
    }),
    { params: Promise.resolve({ id: 'abc' }) },
  );

  assert.deepEqual(await response.json(), { id: 'abc' });
});

test('el proxy propaga el request-id a la respuesta', () => {
  const response = proxy(
    new NextRequest('http://localhost/api/health', {
      headers: { [REQUEST_ID_HEADER]: 'req-proxy-123' },
    }),
  );

  assert.equal(response.headers.get(REQUEST_ID_HEADER), 'req-proxy-123');
  assert.equal(response.headers.get('x-middleware-next'), '1');
});
