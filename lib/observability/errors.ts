/**
 * Captura de errores del cliente, con correlación por `x-request-id`.
 *
 * Este módulo lo importan componentes y utilidades que también corren en el
 * navegador, así que no importa `@sentry/nextjs` de forma estática: el SDK se
 * carga con `./sentry-client` sólo si `NEXT_PUBLIC_SENTRY_DSN` está definido.
 *
 * Las capturas del servidor viven en `./errors-server` para que el bundle del
 * cliente nunca arrastre el SDK.
 *
 * Nunca se adjuntan cuerpos, contraseñas, cookies ni query strings: solo
 * metadatos (ruta, método, status, request-id, tipo de error).
 */

import { recordClientApiError } from './metrics';
import { normalizeRoute } from './routes';
import { withClientSentry } from './sentry-client';
import type { Scope } from '@sentry/nextjs';

export interface ServerErrorContext {
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  /** Contexto legible de la ruta, p. ej. "Error al crear pedido:". */
  context?: string;
  /** Operación de Mongo cuando se conoce (connect, find, save, etc.). */
  mongoOperation?: string;
}

export function errorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return typeof error;
}

/**
 * Detecta errores de Mongo/Mongoose sin depender de una versión concreta del
 * driver. Los errores de validación y duplicado ya se responden como 400/409 y
 * no llegan acá.
 */
export function isMongoError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };

  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (/^(Mongo|Mongoose)/i.test(name)) return true;

  const code = Number(candidate.code);
  if (Number.isFinite(code) && code >= 10_000) return true;

  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return /Mongo(Server|Network|Timeout|Error)|Mongoose|ECONNREFUSED|Server selection timed out|topology is closed|connection .* closed/i.test(
    message,
  );
}

export function tag(scope: Scope, key: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  scope.setTag(key, String(value));
}

export interface ClientErrorContext {
  digest?: string;
  route?: string;
  componentStack?: string;
  /** Boundary de Next que atrapó el error (`global-error`, `error`, etc.). */
  boundary?: string;
}

/** Error de render capturado por un error boundary del cliente. */
export function captureClientError(error: unknown, context: ClientErrorContext = {}): void {
  withClientSentry((Sentry) => {
    Sentry.withScope((scope) => {
      scope.setLevel('error');
      tag(scope, 'error.source', 'client');
      tag(scope, 'error.name', errorName(error));
      tag(scope, 'next.digest', context.digest);
      tag(scope, 'next.boundary', context.boundary);
      tag(scope, 'http.route', context.route ? normalizeRoute(context.route) : undefined);

      if (context.componentStack) {
        scope.setContext('react', { componentStack: context.componentStack });
      }

      Sentry.captureException(error);
    });
  });
}

/** 5xx devuelto por la API: correlaciona con el `x-request-id` de la respuesta. */
export function captureClientApiError(
  error: unknown,
  context: {
    route: string;
    method: string;
    status: number;
    requestId?: string;
  },
): void {
  recordClientApiError(context);

  withClientSentry((Sentry) => {
    Sentry.withScope((scope) => {
      scope.setLevel('error');
      tag(scope, 'error.source', 'api-client');
      tag(scope, 'error.name', errorName(error));
      tag(scope, 'request_id', context.requestId);
      tag(scope, 'http.route', normalizeRoute(context.route));
      tag(scope, 'http.request.method', context.method.toUpperCase());
      tag(scope, 'http.response.status_code', context.status);
      tag(scope, 'http.response.status_class', '5xx');

      Sentry.captureException(error);
    });
  });
}
