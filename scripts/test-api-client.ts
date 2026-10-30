/**
 * Pruebas de `lib/api-client.ts`: el wrapper HTTP que usan las pantallas.
 *
 * Cubre la serialización del cuerpo (JSON vs. FormData), el parseo seguro de
 * respuestas vacías o no-JSON, el error homogéneo con `status`/`payload` y la
 * marca de error de red (fetch rechazado sin respuesta HTTP).
 *
 * No requiere base de datos ni servidor: se reemplaza `globalThis.fetch` con
 * `Response` de Node.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  api,
  apiRequest,
  ApiClientError,
  cancelRequest,
  createAbortController,
  isAbortError,
  isNetworkError,
} from '../lib/api-client';

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;

/**
 * Reemplaza fetch por una respuesta/error fijo y devuelve las llamadas
 * recibidas. Restaura el fetch original al terminar cada test.
 */
const stubFetch = (
  t: { after: (fn: () => void) => void },
  factory: () => Response | Promise<Response>,
) => {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return factory();
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return calls;
};

const jsonResponse = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const textResponse = (status: number, body: string, contentType = 'text/plain') =>
  new Response(body, { status, headers: { 'Content-Type': contentType } });

const emptyResponse = (status: number) => new Response(null, { status });

const header = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

test('GET devuelve el JSON tipado y usa las credenciales same-origin', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { success: true, order: { _id: 'abc' } }));

  const result = await api.get<{ success: true; order: { _id: string } }>('/api/orders/abc', {
    credentials: 'same-origin',
  });

  assert.deepEqual(result, { success: true, order: { _id: 'abc' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/orders/abc');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].init?.credentials, 'same-origin');
});

test('POST serializa objetos como JSON y agrega Content-Type', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(201, { success: true }));

  await api.post('/api/orders', { clientId: 'c1', items: [{ productId: 'p1' }] });

  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(header(calls[0].init, 'Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    clientId: 'c1',
    items: [{ productId: 'p1' }],
  });
});

test('PUT/PATCH/DELETE usan el verbo correspondiente', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { success: true }));

  await api.put('/api/orders/1', { version: 2 });
  await api.patch('/api/orders/1/post-control', { items: [] });
  await api.delete('/api/orders/1');

  assert.deepEqual(
    calls.map((call) => call.init?.method),
    ['PUT', 'PATCH', 'DELETE'],
  );
});

test('FormData se envía tal cual, sin Content-Type manual', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(201, { success: true }));

  const form = new FormData();
  form.append('file', new Blob(['hola']), 'archivo.txt');
  form.append('kind', 'products');

  await api.post('/api/catalog/import', form);

  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.body, form);
  // El navegador/undici debe fijar el boundary del multipart.
  assert.equal(header(calls[0].init, 'Content-Type'), null);
  assert.equal(header(calls[0].init, 'content-type'), null);
});

test('no pisa un Content-Type explícito del llamador', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { success: true }));

  await apiRequest('/api/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.api+json' },
    body: { hello: 'world' },
  });

  assert.equal(header(calls[0].init, 'Content-Type'), 'application/vnd.api+json');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { hello: 'world' });
});

test('un error HTTP lanza ApiClientError con status y payload { error }', async (t) => {
  stubFetch(t, () => jsonResponse(409, { error: 'Versión desactualizada', code: 'STALE' }));

  await assert.rejects(
    () => api.put('/api/orders/1', { version: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.message, 'Versión desactualizada');
      assert.equal(error.status, 409);
      assert.deepEqual(error.payload, {
        error: 'Versión desactualizada',
        code: 'STALE',
      });
      assert.equal(error.isNetworkError, false);
      assert.equal(isNetworkError(error), false);
      return true;
    },
  );
});

test('un error no-JSON conserva el texto como mensaje y payload null', async (t) => {
  stubFetch(t, () => textResponse(502, 'Bad Gateway'));

  await assert.rejects(
    () => api.get('/api/orders'),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.message, 'Bad Gateway');
      assert.equal(error.status, 502);
      assert.equal(error.payload, null);
      return true;
    },
  );
});

test('un error sin cuerpo usa el mensaje genérico con el status', async (t) => {
  stubFetch(t, () => emptyResponse(500));

  await assert.rejects(
    () => api.get('/api/orders'),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.message, 'Error del servidor (500)');
      assert.equal(error.status, 500);
      return true;
    },
  );
});

test('204 y respuestas vacías devuelven undefined', async (t) => {
  stubFetch(t, () => emptyResponse(204));
  assert.equal(await api.delete('/api/orders/1'), undefined);

  stubFetch(t, () => new Response('', { status: 200 }));
  assert.equal(await api.get('/api/orders'), undefined);
});

test('un TypeError de fetch se convierte en error de red con status 0', async (t) => {
  stubFetch(t, () => {
    throw new TypeError('Failed to fetch');
  });

  await assert.rejects(
    () => api.get('/api/orders'),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.status, 0);
      assert.equal(error.isNetworkError, true);
      assert.equal(isNetworkError(error), true);
      assert.ok(error.cause instanceof TypeError);
      return true;
    },
  );
});

test('un error que no es de red se propaga sin envolver', async (t) => {
  const boom = new Error('inesperado');
  stubFetch(t, () => {
    throw boom;
  });

  await assert.rejects(
    () => api.get('/api/orders'),
    (error: unknown) => {
      assert.equal(error, boom);
      assert.equal(isNetworkError(error), false);
      return true;
    },
  );
});

test('reenvía el signal y propaga AbortError sin envolverlo como error de red', async (t) => {
  const controller = createAbortController();
  const calls = stubFetch(
    t,
    () =>
      new Promise<Response>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
      }),
  );

  const pending = api.get('/api/clients', { signal: controller.signal });
  cancelRequest(controller);

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(calls[0].init?.signal, controller.signal);
    assert.equal(isAbortError(error), true);
    assert.equal(error instanceof ApiClientError, false);
    assert.equal(isNetworkError(error), false);
    return true;
  });
});

test('cancelRequest es idempotente y respeta el motivo original', () => {
  const controller = createAbortController();
  const reason = new Error('cambio de filtro');

  cancelRequest(controller, reason);
  cancelRequest(controller, new Error('otro motivo'));

  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, reason);
  assert.equal(isAbortError(reason), false);

  cancelRequest(null);
  cancelRequest(undefined);
});

test('isNetworkError solo reconoce ApiClientError de red', () => {
  assert.equal(isNetworkError(new Error('x')), false);
  assert.equal(isNetworkError(null), false);
  assert.equal(
    isNetworkError(new ApiClientError('sin red', { status: 0, isNetworkError: true })),
    true,
  );
  assert.equal(isNetworkError(new ApiClientError('servidor', { status: 500 })), false);
});
