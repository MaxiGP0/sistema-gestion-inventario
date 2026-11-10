/**
 * Pruebas de observabilidad:
 * - normalización de rutas (cardinalidad),
 * - métricas de requests, login, cola offline y Mongo,
 * - redacción de cuerpos/contraseñas/cookies/query strings,
 * - detección de errores de Mongo,
 * - payloads de monitores/alertas de Sentry,
 * - los errores se envían aunque `tracesSampleRate` sea 0.
 *
 * No requiere DSN ni red: el último test usa un transporte en memoria.
 *
 * Ejecutar con: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Sentry from '@sentry/nextjs';

import {
  APP_MONITORS,
  buildEmailAction,
  buildMonitorPayload,
  buildWorkflowPayload,
  parseAlertTarget,
} from '../lib/observability/sentry-alerts';
import {
  ERROR_SAMPLE_RATE,
  commonSentryOptions,
  getTracesSampleRate,
} from '../lib/observability/sentry-config';
import { isMongoError } from '../lib/observability/errors';
import { captureServerError } from '../lib/observability/errors-server';
import {
  isClientSentryEnabled,
  loadClientSentry,
  withClientSentry,
} from '../lib/observability/sentry-client';
import {
  recordClientApiError,
  recordHttpRequest,
  recordLoginAttempt,
  recordMongoError,
  recordMongoHealth,
  recordOfflineQueueSize,
  recordOfflineSyncResult,
  setMetricsSinkForTests,
  type MetricsSink,
} from '../lib/observability/metrics';
import {
  REDACTED,
  redactFields,
  redactText,
  scrubBreadcrumb,
  scrubEvent,
  scrubUrl,
} from '../lib/observability/redact';
import { normalizeRoute, routeFromUrl } from '../lib/observability/routes';
import {
  REQUEST_ID_HEADER,
  isValidRequestId,
  requestIdFromHeaders,
} from '../lib/observability/request-id';
import { logError } from '../lib/logger';

interface CapturedMetric {
  type: 'count' | 'gauge' | 'distribution';
  name: string;
  value: number;
  options?: unknown;
}

function captureMetrics(): { calls: CapturedMetric[]; restore: () => void } {
  const calls: CapturedMetric[] = [];
  const sink: MetricsSink = {
    count: (name, value = 1, options) => calls.push({ type: 'count', name, value, options }),
    gauge: (name, value, options) => calls.push({ type: 'gauge', name, value, options }),
    distribution: (name, value, options) =>
      calls.push({ type: 'distribution', name, value, options }),
  };

  setMetricsSinkForTests(sink);

  return {
    calls,
    restore: () => setMetricsSinkForTests(null),
  };
}

test('normaliza rutas dinámicas y elimina query strings', () => {
  assert.equal(
    normalizeRoute('/api/orders/64f1234567890abcdef12345/duplicate?token=secreto'),
    '/api/orders/[id]/duplicate',
  );
  assert.equal(
    normalizeRoute('/api/orders/550e8400-e29b-41d4-a716-446655440000'),
    '/api/orders/[id]',
  );
  assert.equal(normalizeRoute('/api/users/12345'), '/api/users/[id]');
  assert.equal(normalizeRoute('/api/health?probe=1'), '/api/health');
  assert.equal(normalizeRoute('/'), '/');
  assert.equal(
    routeFromUrl('https://sgi.test/api/orders/64f1234567890abcdef12345'),
    '/api/orders/[id]',
  );
});

test('emite métricas de latencia, 5xx, login, cola offline y Mongo', () => {
  const captured = captureMetrics();

  try {
    recordHttpRequest({
      method: 'post',
      route: '/api/orders/64f1234567890abcdef12345',
      status: 503,
      durationMs: 12.6,
    });
    recordHttpRequest({ method: 'GET', route: '/api/health', status: 200, durationMs: 4 });

    recordLoginAttempt('invalid_credentials');
    recordLoginAttempt('success');
    recordOfflineQueueSize(3, { online: false, syncing: false });
    recordOfflineSyncResult({ synced: 2, failed: 1, pending: 4, retryableFailures: 1 });
    recordMongoError({ operation: 'find', errorName: 'MongoNetworkError' });
    recordMongoHealth({
      status: 'unavailable',
      latencyMs: 15,
      readyState: 0,
      error: 'ping-failed',
    });
    recordClientApiError({
      route: '/api/orders/64f1234567890abcdef12345',
      method: 'POST',
      status: 500,
    });

    const requests = captured.calls.filter((call) => call.name === 'http.server.requests');
    assert.equal(requests.length, 2);

    const failedRequest = requests[0];
    assert.deepEqual(
      (failedRequest.options as { attributes: Record<string, unknown> }).attributes,
      {
        'http.route': '/api/orders/[id]',
        'http.request.method': 'POST',
        'http.response.status_code': 503,
        'http.response.status_class': '5xx',
      },
    );

    const duration = captured.calls.find((call) => call.name === 'http.server.duration');
    assert.equal(duration?.type, 'distribution');
    assert.deepEqual(duration?.options, {
      unit: 'millisecond',
      attributes: {
        'http.route': '/api/orders/[id]',
        'http.request.method': 'POST',
        'http.response.status_code': 503,
        'http.response.status_class': '5xx',
      },
    });

    assert.equal(
      captured.calls.filter((call) => call.name === 'http.server.errors').length,
      1,
      'el 200 de health no debe contar como error',
    );

    const loginFailures = captured.calls.filter((call) => call.name === 'auth.login.failures');
    assert.equal(loginFailures.length, 1);
    assert.deepEqual(
      (loginFailures[0].options as { attributes: Record<string, unknown> }).attributes,
      {
        'auth.outcome': 'invalid_credentials',
      },
    );

    const queueGauge = captured.calls.find((call) => call.name === 'offline.queue.size');
    assert.equal(queueGauge?.type, 'gauge');
    assert.equal(queueGauge?.value, 3);
    assert.deepEqual((queueGauge?.options as { attributes: Record<string, unknown> }).attributes, {
      'offline.online': false,
      'offline.syncing': false,
    });

    assert.ok(captured.calls.some((call) => call.name === 'offline.queue.sync_failures'));
    assert.ok(captured.calls.some((call) => call.name === 'db.mongo.errors'));
    assert.ok(captured.calls.some((call) => call.name === 'db.mongo.health.failures'));
    assert.ok(captured.calls.some((call) => call.name === 'client.api.errors'));
  } finally {
    captured.restore();
  }
});

test('redacta cuerpos, contraseñas, cookies y query strings', () => {
  const event = scrubEvent({
    message: 'fallo con password=secreto y Bearer abc.def',
    request: {
      url: 'https://sgi.test/api/orders?token=secreto&cliente=Ana',
      headers: {
        authorization: 'Bearer secreto',
        cookie: 'session=abc',
        'x-request-id': 'req-12345678',
        'user-agent': 'Sistema de Gestión de InventarioTest/1.0',
      },
      data: { password: 'secreto', cliente: 'Ana' },
      cookies: { session: 'abc' },
      query_string: 'token=secreto',
    },
    user: { email: 'ana@example.com', ip_address: '203.0.113.1' },
    extra: {
      body: { password: 'secreto', cliente: 'Ana' },
      customer: { email: 'ana@example.com', phone: '555-1234' },
      safe: 'ok',
    },
    breadcrumbs: [
      { category: 'console', data: { arguments: ['password=secreto'] } },
      {
        category: 'fetch',
        data: {
          url: 'https://sgi.test/api/orders?token=secreto',
          method: 'POST',
          body: '{"password":"secreto"}',
          status_code: 500,
        },
      },
    ],
    exception: { values: [{ value: 'token=secreto' }] },
  });

  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes('secreto'), 'no debe quedar ningún secreto');
  assert.ok(!serialized.includes('ana@example.com'), 'no debe quedar el email');
  assert.ok(!serialized.includes('203.0.113.1'), 'no debe quedar la IP');
  assert.ok(!serialized.includes('session=abc'), 'no debe quedar la cookie');
  assert.equal((event.request as Record<string, unknown>).data, undefined);
  assert.equal((event.request as Record<string, unknown>).cookies, undefined);
  assert.equal((event.request as Record<string, unknown>).query_string, undefined);
  assert.equal((event.request as Record<string, unknown>).url, 'https://sgi.test/api/orders');
  assert.deepEqual((event.request as Record<string, unknown>).headers, {
    'x-request-id': 'req-12345678',
    'user-agent': 'Sistema de Gestión de InventarioTest/1.0',
  });
  assert.equal(event.user, undefined);
  assert.equal((event.extra as Record<string, unknown>).safe, 'ok');
  assert.equal((event.extra as Record<string, unknown>).body, REDACTED);

  const [consoleBreadcrumb, fetchBreadcrumb] = event.breadcrumbs as Array<Record<string, unknown>>;
  assert.equal(consoleBreadcrumb.data, undefined);
  assert.equal((fetchBreadcrumb.data as Record<string, unknown>).body, undefined);
  assert.equal(
    (fetchBreadcrumb.data as Record<string, unknown>).url,
    'https://sgi.test/api/orders',
  );

  assert.equal(redactText('password=abc123'), `password=${REDACTED}`);
  assert.equal(scrubUrl('/api/orders?token=abc#x'), '/api/orders');
  assert.deepEqual(redactFields({ password: 'x', body: { a: 1 }, path: '/api/orders' }), {
    password: REDACTED,
    body: REDACTED,
    path: '/api/orders',
  });
  assert.equal(scrubBreadcrumb({ category: 'console', data: { a: 1 } }).data, undefined);
});

test('clasifica errores de Mongo y valida request-id', () => {
  assert.equal(isMongoError({ name: 'MongoServerError', message: 'boom' }), true);
  assert.equal(isMongoError({ name: 'MongooseServerSelectionError', message: 'timeout' }), true);
  assert.equal(isMongoError(new Error('connect ECONNREFUSED 127.0.0.1:27017')), true);
  assert.equal(isMongoError(new Error('Error de validación de negocio')), false);

  assert.equal(isValidRequestId('req-12345678'), true);
  assert.equal(isValidRequestId('id con espacios'), false);
  assert.equal(isValidRequestId('corto'), false);
  assert.equal(requestIdFromHeaders({ [REQUEST_ID_HEADER]: 'req-abcdefgh' }), 'req-abcdefgh');
});

test('el logger no serializa keyValue, bodies ni contraseñas', () => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'error';
  const lines: string[] = [];
  const original = console.error;

  console.error = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };

  try {
    logError('mongo.error', {
      name: 'MongoServerError',
      message: 'duplicado con password=secreto',
      code: 11000,
      keyValue: { email: 'ana@example.com' },
      body: { password: 'secreto', cliente: 'Ana' },
    });
  } finally {
    console.error = original;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }

  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('ana@example.com'));
  assert.ok(!lines[0].includes('secreto'));
  assert.ok(!lines[0].includes('keyValue'));
  assert.ok(lines[0].includes('MongoServerError'));
  assert.ok(lines[0].includes('11000'));
});

test('las opciones de Sentry no muestrean errores y restringen la recolección', () => {
  assert.equal(ERROR_SAMPLE_RATE, 1);

  const previous = process.env.SENTRY_TRACES_SAMPLE_RATE;
  process.env.SENTRY_TRACES_SAMPLE_RATE = '0';

  try {
    assert.equal(getTracesSampleRate(), 0);

    const options = commonSentryOptions('server');
    assert.equal(options.sampleRate, 1);
    assert.equal(options.tracesSampler({ name: 'GET /api/health' }), 0);
    assert.equal(options.tracesSampler({ name: 'POST /api/orders' }), 0);
    assert.equal(options.sendDefaultPii, false);
    assert.equal(options.dataCollection.userInfo, false);
    assert.equal(options.dataCollection.cookies, false);
    assert.deepEqual(options.dataCollection.httpBodies, []);
    assert.equal(options.dataCollection.urlQueryParams, false);
    assert.equal(options.dataCollection.databaseQueryData, false);
    assert.deepEqual(options.initialScope.tags, {
      app: 'sistema-gestion-inventario',
      runtime: 'server',
    });
  } finally {
    if (previous === undefined) delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    else process.env.SENTRY_TRACES_SAMPLE_RATE = previous;
  }

  process.env.SENTRY_TRACES_SAMPLE_RATE = '0.25';
  try {
    assert.equal(getTracesSampleRate(), 0.25);
  } finally {
    if (previous === undefined) delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    else process.env.SENTRY_TRACES_SAMPLE_RATE = previous;
  }
});

test('construye monitores y alertas con umbrales esperados', () => {
  const health = APP_MONITORS.find((monitor) => monitor.key === 'health-503');
  const spike = APP_MONITORS.find((monitor) => monitor.key === '5xx-spike');
  const mongo = APP_MONITORS.find((monitor) => monitor.key === 'mongo-errors');

  assert.ok(health && spike && mongo);

  const healthPayload = buildMonitorPayload(health, { environment: 'production' });
  assert.equal(healthPayload.type, 'metric_issue');
  assert.deepEqual(
    (healthPayload.data_sources as Array<Record<string, unknown>>)[0].query,
    'http.route:"/api/health" http.response.status_class:5xx',
  );
  assert.deepEqual((healthPayload.condition_group as { conditions: unknown[] }).conditions, [
    { type: 'gt', comparison: 0, conditionResult: 75 },
    { type: 'lte', comparison: 0, conditionResult: 0 },
  ]);

  const spikeConditions = (buildMonitorPayload(spike).condition_group as { conditions: unknown[] })
    .conditions;
  assert.deepEqual(spikeConditions, [
    { type: 'gt', comparison: 5, conditionResult: 75 },
    { type: 'gt', comparison: 1, conditionResult: 50 },
    { type: 'lte', comparison: 1, conditionResult: 0 },
  ]);

  const mongoConditions = (buildMonitorPayload(mongo).condition_group as { conditions: unknown[] })
    .conditions;
  assert.deepEqual(mongoConditions, [
    { type: 'gt', comparison: 0, conditionResult: 75 },
    { type: 'lte', comparison: 0, conditionResult: 0 },
  ]);

  assert.deepEqual(parseAlertTarget('team:42'), { type: 'team', id: '42' });
  assert.equal(parseAlertTarget('otro:42'), undefined);

  const workflow = buildWorkflowPayload({
    name: 'Sistema de Gestión de Inventario · Alerta de prueba',
    detectorId: '123',
    actions: [buildEmailAction({ type: 'user', id: '456' })],
    environment: 'production',
  });

  assert.deepEqual(workflow.detector_ids, ['123']);
  assert.deepEqual(workflow.config, { frequency: 5 });
  assert.equal((workflow.triggers as { logicType: string }).logicType, 'any-short');
  assert.equal((workflow.actionFilters as Array<{ actions: unknown[] }>)[0].actions.length, 1);
});

test('Sentry del cliente no se carga sin NEXT_PUBLIC_SENTRY_DSN', async () => {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) return; // el entorno define un DSN real

  assert.equal(isClientSentryEnabled(), false);
  assert.equal(await loadClientSentry(), null);

  let executed = false;
  withClientSentry(() => {
    executed = true;
  });
  assert.equal(executed, false, 'sin DSN la tarea no debe ejecutarse ni cargar el SDK');
});

test('Sentry envía errores aunque tracesSampleRate sea 0', async () => {
  const envelopes: string[] = [];

  Sentry.init({
    dsn: 'https://public@example.com/1',
    sampleRate: 1,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    transport: () =>
      ({
        send: async (envelope: unknown) => {
          envelopes.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      }) as never,
  } as never);

  try {
    const eventId = Sentry.captureException(new Error('error-real-de-prueba'));
    assert.ok(eventId, 'captureException debe devolver un event id');

    captureServerError(new Error('error-server-de-prueba'), {
      requestId: 'req-12345678',
      route: '/api/orders/64f1234567890abcdef12345',
      method: 'GET',
      status: 500,
    });

    await Sentry.flush(2_000);

    assert.ok(
      envelopes.some((envelope) => envelope.includes('error-real-de-prueba')),
      'el error debe enviarse aunque el sampling de traces sea 0',
    );
    assert.ok(
      envelopes.some(
        (envelope) =>
          envelope.includes('error-server-de-prueba') &&
          envelope.includes('req-12345678') &&
          envelope.includes('/api/orders/[id]'),
      ),
      'el error de servidor debe llevar request_id y ruta normalizada',
    );
  } finally {
    await Sentry.close(2_000);
  }
});
