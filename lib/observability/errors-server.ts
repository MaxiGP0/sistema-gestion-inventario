/**
 * Captura de errores en Sentry para el servidor (Node/Edge).
 *
 * A diferencia de `./errors`, este módulo importa `@sentry/nextjs` de forma
 * estática porque nunca se incluye en el bundle del cliente. Lo usan el proxy,
 * `handleRouteError`, el health check e `instrumentation.ts`.
 *
 * Nunca se adjuntan cuerpos, contraseñas, cookies ni query strings: solo
 * metadatos (ruta, método, status, request-id, tipo de error).
 */

import * as Sentry from '@sentry/nextjs';
import { errorName, isMongoError, tag, type ServerErrorContext } from './errors';
import { recordMongoError } from './metrics';
import { requestIdFromHeaders, type HeaderBag } from './request-id';
import { normalizeRoute } from './routes';

const HEALTH_CAPTURE_INTERVAL_MS = 5 * 60 * 1_000;
const healthCaptureTimes = new Map<string, number>();

/** Error de servidor no controlado: siempre se captura (sampleRate = 1). */
export function captureServerError(error: unknown, context: ServerErrorContext = {}): void {
  const mongo = isMongoError(error);
  const name = errorName(error);

  if (mongo) {
    recordMongoError({
      operation: context.mongoOperation ?? 'unknown',
      errorName: name,
    });
  }

  Sentry.withScope((scope) => {
    scope.setLevel('error');
    tag(scope, 'error.source', mongo ? 'mongodb' : 'server');
    tag(scope, 'error.name', name);
    tag(scope, 'request_id', context.requestId);
    tag(scope, 'http.route', context.route ? normalizeRoute(context.route) : undefined);
    tag(scope, 'http.request.method', context.method?.toUpperCase());
    tag(scope, 'http.response.status_code', context.status);
    tag(scope, 'http.response.status_class', context.status ? '5xx' : undefined);

    if (mongo) {
      tag(scope, 'db.system', 'mongodb');
      tag(scope, 'db.operation', context.mongoOperation ?? 'unknown');
    }

    scope.setContext('request', {
      requestId: context.requestId,
      route: context.route ? normalizeRoute(context.route) : undefined,
      method: context.method,
      status: context.status,
      context: context.context,
    });

    Sentry.captureException(error);
  });
}

interface NextRequestInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

interface NextErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
}

/**
 * Hook `onRequestError` de Next: errores no atrapados en Server Components,
 * route handlers y proxy. El request-id viene del header que puso `proxy.ts`.
 */
export async function captureRequestError(
  error: unknown,
  request: NextRequestInfo,
  context: NextErrorContext,
): Promise<void> {
  const requestId = requestIdFromHeaders(request.headers as HeaderBag);
  const route = normalizeRoute(context.routePath || request.path);
  const mongo = isMongoError(error);

  if (mongo) {
    recordMongoError({ operation: 'request', errorName: errorName(error) });
  }

  Sentry.withScope((scope) => {
    scope.setLevel('error');
    tag(scope, 'error.source', mongo ? 'mongodb' : 'server');
    tag(scope, 'error.name', errorName(error));
    tag(scope, 'request_id', requestId);
    tag(scope, 'http.route', route);
    tag(scope, 'http.request.method', request.method?.toUpperCase());
    tag(scope, 'http.response.status_class', '5xx');
    tag(scope, 'next.router_kind', context.routerKind);
    tag(scope, 'next.route_type', context.routeType);

    if (mongo) {
      tag(scope, 'db.system', 'mongodb');
      tag(scope, 'db.operation', 'request');
    }

    scope.setContext('request', {
      requestId,
      route,
      method: request.method,
    });
    scope.setContext('nextjs', {
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
    });

    Sentry.captureException(error);
  });

  // Next puede terminar el proceso/serverless al volver del hook.
  await Sentry.flush(2_000).catch(() => undefined);
}

/** 503 en /api/health: un evento agrupado por motivo, no uno por probe. */
export function captureHealthFailure(input: {
  reason: string;
  readyState?: number;
  latencyMs?: number;
}): void {
  // Un probe cada minuto con Mongo caído no debe generar un evento por minuto.
  // La primera falla se reporta al instante; luego se agrupa cada 5 minutos.
  const now = Date.now();
  const lastSentAt = healthCaptureTimes.get(input.reason) ?? 0;
  if (now - lastSentAt < HEALTH_CAPTURE_INTERVAL_MS) return;
  healthCaptureTimes.set(input.reason, now);

  Sentry.withScope((scope) => {
    scope.setLevel('error');
    tag(scope, 'error.source', 'mongodb');
    tag(scope, 'error.name', `health-${input.reason}`);
    tag(scope, 'http.route', '/api/health');
    tag(scope, 'http.response.status_code', 503);
    tag(scope, 'http.response.status_class', '5xx');
    tag(scope, 'db.system', 'mongodb');
    tag(scope, 'health.status', 'degraded');
    tag(scope, 'health.reason', input.reason);

    scope.setFingerprint(['sgi-health-check', input.reason]);
    scope.setContext('mongodb', {
      status: 'unavailable',
      reason: input.reason,
      readyState: input.readyState,
      latencyMs: input.latencyMs,
    });

    Sentry.captureMessage(`Health check degradado: ${input.reason}`);
  });
}
