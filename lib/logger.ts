/**
 * Logging estructurado (una línea JSON por evento) y contexto por request.
 *
 * `withRouteLogging` envuelve un route handler: resuelve un request-id
 * (respetando `x-request-id` si es válido, o generando uno), lo deja disponible
 * vía AsyncLocalStorage para los logs internos (por ejemplo `handleRouteError`)
 * y registra el resultado de la petición con método, ruta y duración.
 *
 * No se registran cuerpos, cookies ni query strings: solo metadatos.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { recordHttpRequest } from './observability/metrics';
import { redactFields, redactText } from './observability/redact';
import { REQUEST_ID_HEADER, requestIdFromHeaders } from './observability/request-id';

export { REQUEST_ID_HEADER };

export type LogLevel = 'info' | 'warn' | 'error';

interface RequestLogContext {
  requestId: string;
  method: string;
  path: string;
}

const requestContext = new AsyncLocalStorage<RequestLogContext>();

export interface RequestLogInfo extends RequestLogContext {
  status: number;
  durationMs: number;
}

export type LogFields = Record<string, unknown>;

/** Nivel mínimo a emitir. `LOG_LEVEL=silent` apaga todo (tests). */
const LEVEL_WEIGHT: Record<string, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
};

function currentLevel(): number {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  return configured && configured in LEVEL_WEIGHT ? LEVEL_WEIGHT[configured] : LEVEL_WEIGHT.info;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] <= currentLevel();
}

/** Contexto del request en curso (si el handler está envuelto). */
export function getRequestContext(): RequestLogContext | undefined {
  return requestContext.getStore();
}

/** Acepta un request-id de un proxy/cliente solo si tiene forma segura. */
export function resolveRequestId(request?: Request | null): string {
  return requestIdFromHeaders(request?.headers) ?? randomUUID();
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactText(error.message),
      ...(error.stack ? { stack: redactText(error.stack) } : {}),
    };
  }

  if (error && typeof error === 'object') {
    // No se serializa el objeto completo: un error de driver puede traer
    // keyValue/body con datos personales. Solo metadatos acotados.
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      keyPattern?: unknown;
      errors?: unknown;
    };

    return {
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
      message:
        typeof candidate.message === 'string' ? redactText(candidate.message) : 'Error sin mensaje',
      ...(typeof candidate.code === 'string' || typeof candidate.code === 'number'
        ? { code: candidate.code }
        : {}),
      ...(candidate.keyPattern && typeof candidate.keyPattern === 'object'
        ? { keyPattern: Object.keys(candidate.keyPattern) }
        : {}),
      ...(candidate.errors && typeof candidate.errors === 'object'
        ? { errorPaths: Object.keys(candidate.errors) }
        : {}),
    };
  }

  return { message: redactText(String(error)) };
}

function write(level: LogLevel, message: string, fields?: LogFields, error?: unknown): void {
  if (!shouldLog(level)) return;

  const context = getRequestContext();
  const safeFields = fields ? redactFields(fields) : undefined;
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    message: redactText(message),
    ...(context
      ? {
          requestId: context.requestId,
          method: context.method,
          path: context.path,
        }
      : {}),
    ...(safeFields ?? {}),
    ...(error !== undefined ? { error: serializeError(error) } : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      error: 'No se pudo serializar el evento de log',
    });
  }

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(message: string, fields?: LogFields): void {
  write('info', message, fields);
}

export function logWarn(message: string, fields?: LogFields): void {
  write('warn', message, fields);
}

export function logError(message: string, error?: unknown, fields?: LogFields): void {
  write('error', message, fields, error);
}

/** Agrega el request-id a la respuesta (incluidas redirects y errores). */
export function attachRequestId<T extends Response>(response: T, requestId: string): T {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
  } catch {
    // Una respuesta con headers inmutables no debe romper el handler.
  }

  return response;
}

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
}

type RouteHandler<Args extends unknown[]> = (...args: Args) => Response | Promise<Response>;

/**
 * Envuelve un handler de `app/api/**` para registrar el request con su
 * request-id. Conserva la firma (incluido el contexto con `params`).
 */
export function withRouteLogging(
  handler: () => Response | Promise<Response>,
): (request?: Request) => Promise<Response>;
export function withRouteLogging<Args extends unknown[]>(
  handler: RouteHandler<Args>,
): (...args: Args) => Promise<Response>;
export function withRouteLogging<Args extends unknown[]>(
  handler: RouteHandler<Args>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    const request = args[0];

    // Handlers invocados directamente en tests sin Request: se delegan igual.
    if (!isRequest(request)) {
      return handler(...args);
    }

    const startedAt = Date.now();
    const requestId = resolveRequestId(request);
    const context: RequestLogContext = {
      requestId,
      method: request.method || 'GET',
      path: requestPath(request),
    };

    return requestContext.run(context, async () => {
      let status = 500;

      try {
        const response = await handler(...args);
        status = response.status;
        return attachRequestId(response, requestId);
      } catch (error) {
        logError('request.failed', error, { status: 500 });
        throw error;
      } finally {
        const durationMs = Date.now() - startedAt;
        const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

        write(level, 'request.completed', {
          status,
          durationMs,
        });

        // Métricas independientes de LOG_LEVEL: el log puede estar silenciado,
        // pero las series de latencia/errores se siguen emitiendo.
        recordHttpRequest({
          method: context.method,
          route: context.path,
          status,
          durationMs,
        });
      }
    });
  };
}
