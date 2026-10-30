/**
 * Métricas de aplicación (Sentry Application Metrics).
 *
 * Se emiten counters, gauges y distribuciones con atributos acotados para no
 * explotar la cardinalidad. Las métricas no dependen del sampling de traces:
 * Sentry las envía aunque `tracesSampleRate` sea 0. Los errores reales se
 * capturan aparte con `sampleRate: 1` (ver `lib/observability/sentry-config.ts`).
 *
 * Todas las llamadas son best-effort: un fallo de observabilidad nunca debe
 * romper una request ni una sincronización offline.
 */

import { normalizeRoute } from './routes';
import type { WebVitalReport } from './web-vitals';

export type MetricAttributes = Record<string, string | number | boolean>;

export interface MetricOptions {
  /** Distribuciones temporales en ms y CLS como ratio adimensional. */
  unit?: 'millisecond' | 'ratio';
  attributes?: MetricAttributes;
}

export interface MetricsSink {
  count(name: string, value?: number, options?: MetricOptions): void;
  gauge(name: string, value: number, options?: MetricOptions): void;
  distribution(name: string, value: number, options?: MetricOptions): void;
}

/**
 * Sink por defecto: no-op. El sink real de Sentry se registra desde
 * `instrumentation.ts` (servidor) o `instrumentation-client.ts` (navegador)
 * cuando hay DSN. Así este módulo, que también corre en el cliente, no arrastra
 * el SDK de Sentry al bundle inicial.
 */
const noopSink: MetricsSink = {
  count() {},
  gauge() {},
  distribution() {},
};

let sink: MetricsSink = noopSink;

/** Registra el sink activo; `null` vuelve al no-op. */
export function setMetricsSink(next: MetricsSink | null): void {
  sink = next ?? noopSink;
}

/** Solo para pruebas: reemplaza el sink sin inicializar Sentry. */
export function setMetricsSinkForTests(next: MetricsSink | null): void {
  setMetricsSink(next);
}

function emit(action: () => void): void {
  try {
    action();
  } catch {
    // La observabilidad es best-effort.
  }
}

export interface HttpRequestMetric {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

/** Métricas por request: latencia, total y errores 5xx por ruta. */
export function recordHttpRequest({ method, route, status, durationMs }: HttpRequestMetric): void {
  const normalizedRoute = normalizeRoute(route);
  const statusCode = Number.isFinite(status) ? Math.round(status) : 500;
  const statusClass =
    statusCode >= 100 && statusCode <= 599 ? `${Math.floor(statusCode / 100)}xx` : 'unknown';
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;

  const attributes: MetricAttributes = {
    'http.route': normalizedRoute,
    'http.request.method': method.toUpperCase(),
    'http.response.status_code': statusCode,
    'http.response.status_class': statusClass,
  };

  emit(() => sink.count('http.server.requests', 1, { attributes }));
  emit(() =>
    sink.distribution('http.server.duration', safeDuration, {
      unit: 'millisecond',
      attributes,
    }),
  );

  if (statusCode >= 500) {
    emit(() =>
      sink.count('http.server.errors', 1, {
        attributes: { ...attributes, 'error.type': '5xx' },
      }),
    );
  }
}

export type LoginOutcome =
  | 'success'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'disabled'
  | 'validation_error'
  | 'server_error';

/** Intentos de login y fallos, separados por motivo (sin usuario ni IP). */
export function recordLoginAttempt(outcome: LoginOutcome): void {
  const attributes: MetricAttributes = { 'auth.outcome': outcome };

  emit(() => sink.count('auth.login.attempts', 1, { attributes }));

  if (outcome !== 'success') {
    emit(() => sink.count('auth.login.failures', 1, { attributes }));
  }
}

/** Tamaño actual de la cola offline (IndexedDB). */
export function recordOfflineQueueSize(
  size: number,
  context: { online?: boolean; syncing?: boolean } = {},
): void {
  if (!Number.isFinite(size) || size < 0) return;

  emit(() =>
    sink.gauge('offline.queue.size', Math.round(size), {
      attributes: {
        'offline.online': context.online ?? false,
        'offline.syncing': context.syncing ?? false,
      },
    }),
  );
}

/** Resultado de una pasada de sincronización de la cola offline. */
export function recordOfflineSyncResult(result: {
  synced: number;
  failed: number;
  pending: number;
  retryableFailures?: number;
}): void {
  const attributes: MetricAttributes = {
    'offline.synced': Math.max(0, Math.round(result.synced)),
    'offline.failed': Math.max(0, Math.round(result.failed)),
    'offline.retryable_failures': Math.max(0, Math.round(result.retryableFailures ?? 0)),
  };

  emit(() => sink.count('offline.queue.sync_runs', 1, { attributes }));
  recordOfflineQueueSize(result.pending, { online: true, syncing: false });

  if (result.failed > 0) {
    emit(() => sink.count('offline.queue.sync_failures', 1, { attributes }));
  }
}

/** Error de Mongo/Mongoose, con operación y nombre acotados. */
export function recordMongoError(input: { operation: string; errorName: string }): void {
  emit(() =>
    sink.count('db.mongo.errors', 1, {
      attributes: {
        'db.system': 'mongodb',
        'db.operation': input.operation.slice(0, 80),
        'error.name': input.errorName.slice(0, 120),
      },
    }),
  );
}

/** Latencia y resultado del health check de Mongo. */
export function recordMongoHealth(input: {
  status: 'connected' | 'unavailable';
  latencyMs: number;
  readyState?: number;
  error?: string;
}): void {
  const attributes: MetricAttributes = {
    'db.system': 'mongodb',
    'db.mongo.status': input.status,
    'db.mongo.ready_state': input.readyState ?? -1,
    ...(input.error ? { 'error.type': input.error } : {}),
  };

  emit(() => sink.count('db.mongo.health.checks', 1, { attributes }));
  emit(() =>
    sink.distribution('db.mongo.health.duration', Math.max(0, Math.round(input.latencyMs)), {
      unit: 'millisecond',
      attributes,
    }),
  );

  if (input.status === 'unavailable') {
    emit(() => sink.count('db.mongo.health.failures', 1, { attributes }));
  }
}

/** 5xx observado desde el cliente (apiRequest), con request-id de la respuesta. */
export function recordClientApiError(input: {
  route: string;
  method: string;
  status: number;
}): void {
  emit(() =>
    sink.count('client.api.errors', 1, {
      attributes: {
        'http.route': normalizeRoute(input.route),
        'http.request.method': input.method.toUpperCase(),
        'http.response.status_code': Math.round(input.status),
        'http.response.status_class': '5xx',
      },
    }),
  );
}

/**
 * Web Vitals medidos en el navegador. Se emiten como una distribución por
 * métrica (`web.vitals.lcp`, `web.vitals.inp`, `web.vitals.cls`,
 * `web.vitals.ttfb`) para poder calcular p75 por ruta, dispositivo y release.
 *
 * Los atributos son acotados y sin PII: ruta normalizada, clase de dispositivo,
 * release del build, rating y tipo de navegación. No se envía la URL completa,
 * el `id` del metric, el user agent ni datos de la sesión.
 */
export function recordWebVital(vital: WebVitalReport): void {
  const attributes: MetricAttributes = {
    'web.vital': vital.name,
    'web.vital.rating': vital.rating,
    'web.vital.navigation_type': vital.navigationType,
    'http.route': vital.route,
    'device.class': vital.deviceClass,
    release: vital.release,
  };

  emit(() =>
    sink.distribution(`web.vitals.${vital.name.toLowerCase()}`, vital.value, {
      unit: vital.unit,
      attributes,
    }),
  );
}
