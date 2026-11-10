/**
 * Cliente HTTP único para las pantallas: centraliza `fetch`, el parseo seguro
 * del cuerpo y el manejo homogéneo de errores (`{ error }` de las rutas).
 *
 * - Serializa objetos/arrays como JSON y deja pasar `FormData`/`Blob`/texto.
 * - Devuelve `undefined` en respuestas 204 (sin cuerpo).
 * - Lanza `ApiClientError` con `status`, `payload` y la marca `isNetworkError`
 *   para que la UI pueda distinguir un corte de red de un error del servidor.
 */

import type { ApiErrorBody } from './types';
import { captureClientApiError } from './observability/errors';
import { REQUEST_ID_HEADER } from './observability/request-id';
import { routeFromUrl } from './observability/routes';
import { createRequestTimeout, raceWithAbort } from './request-timeout';

/** Tiempo máximo por defecto de una petición HTTP. `0` lo desactiva. */
export const API_REQUEST_TIMEOUT_MS = 15_000;
/** Lecturas de catálogo: se degradan rápido a la copia local. */
export const CATALOG_REQUEST_TIMEOUT_MS = 8_000;
/** Export/import: operaciones largas que no deben cortarse a los 15 s. */
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

/** Mensaje homogéneo cuando una petición vence por timeout. */
export const API_TIMEOUT_MESSAGE =
  'La conexión tardó demasiado. Revisá tu señal e intentá de nuevo.';

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /**
   * Cuerpo de la petición. Los objetos/arrays se serializan como JSON; los
   * tipos nativos de `fetch` (`FormData`, `Blob`, `URLSearchParams`, etc.) se
   * envían tal cual.
   */
  body?: unknown;
  /**
   * Señal para cancelar la petición. Se combina con el timeout interno: al
   * abortarla, la promesa rechaza con un error de tipo `AbortError` (no se
   * envuelve como error de red ni se reporta a Sentry).
   *
   * Usar `createAbortController()`/`cancelRequest()` para el ciclo de vida
   * habitual, o `createLatestRequest()` cuando la regla es "gana la última".
   */
  signal?: AbortSignal;
  /**
   * Tiempo máximo de la petición en milisegundos. Por defecto 15 s; `0`
   * desactiva el timeout. Los flujos largos (export/import) deben pasar
   * `LONG_REQUEST_TIMEOUT_MS` y las lecturas de catálogo usan 8 s.
   */
  timeoutMs?: number;
}

/** Crea un controlador listo para cancelar una petición en curso. */
export function createAbortController(): AbortController {
  return new AbortController();
}

/**
 * Cancela una petición si todavía está en curso. Es idempotente: llamar dos
 * veces sobre el mismo controlador no lanza ni cambia el motivo original.
 */
export function cancelRequest(
  controller: AbortController | null | undefined,
  reason?: unknown,
): void {
  if (!controller || controller.signal.aborted) return;
  controller.abort(reason);
}

/** ¿El error proviene de una petición cancelada con `AbortController`? */
export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export interface ApiClientErrorOptions {
  status: number;
  payload?: ApiErrorBody | null;
  /** `true` cuando `fetch` no pudo conectarse (sin respuesta HTTP). */
  isNetworkError?: boolean;
  /** `true` cuando la petición se cortó por vencer `timeoutMs`. */
  isTimeout?: boolean;
  cause?: unknown;
}

/** Error homogéneo de una petición HTTP. */
export class ApiClientError extends Error {
  /** Código HTTP; `0` cuando la petición ni siquiera llegó al servidor. */
  readonly status: number;
  /** Cuerpo de error parseado de la API, si lo hubo. */
  readonly payload: ApiErrorBody | null;
  readonly isNetworkError: boolean;
  readonly isTimeout: boolean;

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiClientError';
    this.status = options.status;
    this.payload = options.payload ?? null;
    this.isNetworkError = options.isNetworkError ?? false;
    this.isTimeout = options.isTimeout ?? false;
  }
}

/** ¿El error se produjo por falta de conexión (no por una respuesta HTTP)? */
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiClientError && error.isNetworkError;
}

/** ¿La petición se cortó porque venció el timeout? */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof ApiClientError && error.isTimeout;
}

function createTimeoutError(cause?: unknown): ApiClientError {
  return new ApiClientError(API_TIMEOUT_MESSAGE, {
    status: 0,
    isNetworkError: true,
    isTimeout: true,
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tipos de cuerpo que `fetch` entiende sin serialización adicional. */
function isNativeBody(body: unknown): body is BodyInit {
  return (
    typeof body === 'string' ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
  );
}

function serializeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (isNativeBody(body)) return body;

  // JSON por defecto; no se pisa un Content-Type explícito del llamador.
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return JSON.stringify(body);
}

/** Parsea JSON si el cuerpo es JSON válido; si no, conserva el texto. */
function parseBody(text: string): { payload: unknown; isEmpty: boolean } {
  if (!text) return { payload: null, isEmpty: true };

  try {
    return { payload: JSON.parse(text), isEmpty: false };
  } catch {
    return { payload: text, isEmpty: false };
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  if (typeof payload === 'string' && payload.trim()) return payload;
  return `Error del servidor (${status})`;
}

/**
 * Realiza una petición y devuelve el cuerpo tipado.
 *
 * @throws {ApiClientError} si la respuesta no es 2xx o si no hubo conexión.
 */
export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const {
    body,
    headers: rawHeaders,
    timeoutMs = API_REQUEST_TIMEOUT_MS,
    signal: externalSignal,
    ...rest
  } = options;
  const headers = new Headers(rawHeaders);
  const serializedBody = serializeBody(body, headers);
  const timeout = createRequestTimeout(timeoutMs, externalSignal);

  try {
    let response: Response;

    try {
      response = await raceWithAbort(
        fetch(url, { ...rest, headers, body: serializedBody, signal: timeout.signal }),
        timeout.signal,
      );
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      // Una cancelación no es un fallo: se propaga tal cual para que la capa
      // que la pidió pueda ignorarla (y no se confunda con un corte de red).
      if (externalSignal?.aborted) throw error;
      if (timeout.timedOut()) throw createTimeoutError(error);
      if (isAbortError(error)) throw error;
      if (error instanceof TypeError) {
        throw new ApiClientError('No se pudo conectar con el servidor', {
          status: 0,
          isNetworkError: true,
          cause: error,
        });
      }
      throw error;
    }

    // 204/205 no tienen cuerpo por definición.
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }

    const text = await response.text();
    const { payload, isEmpty } = parseBody(text);

    if (!response.ok) {
      // Los 5xx son fallos reales: se reportan con el x-request-id de la
      // respuesta para correlacionar con el log del servidor. No se adjunta el
      // cuerpo (puede contener datos del pedido o del cliente).
      if (response.status >= 500) {
        captureClientApiError(new Error(`Error HTTP ${response.status}`), {
          route: routeFromUrl(url),
          method: (options.method ?? 'GET').toUpperCase(),
          status: response.status,
          requestId: response.headers.get(REQUEST_ID_HEADER) ?? undefined,
        });
      }

      throw new ApiClientError(errorMessage(payload, response.status), {
        status: response.status,
        payload: isRecord(payload) ? (payload as ApiErrorBody) : null,
      });
    }

    // Respuestas exitosas sin cuerpo (204 ya cubierto, pero también 200 vacío).
    if (isEmpty) return undefined as T;

    return payload as T;
  } catch (error) {
    // La lectura del cuerpo también puede abortarse si el timeout vence
    // después de recibir los headers.
    if (externalSignal?.aborted) throw error;
    if (timeout.timedOut() && !(error instanceof ApiClientError && error.isTimeout)) {
      throw createTimeoutError(error);
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

type RequestOptionsWithoutBody = Omit<ApiRequestOptions, 'method' | 'body'>;

/** Atajos por verbo HTTP. */
export const api = {
  get: <T>(url: string, options: RequestOptionsWithoutBody = {}) =>
    apiRequest<T>(url, { ...options, method: 'GET' }),

  post: <T>(url: string, body?: unknown, options: RequestOptionsWithoutBody = {}) =>
    apiRequest<T>(url, { ...options, method: 'POST', body }),

  put: <T>(url: string, body?: unknown, options: RequestOptionsWithoutBody = {}) =>
    apiRequest<T>(url, { ...options, method: 'PUT', body }),

  patch: <T>(url: string, body?: unknown, options: RequestOptionsWithoutBody = {}) =>
    apiRequest<T>(url, { ...options, method: 'PATCH', body }),

  delete: <T>(url: string, options: RequestOptionsWithoutBody = {}) =>
    apiRequest<T>(url, { ...options, method: 'DELETE' }),
};
