/**
 * Helpers puros para el `x-request-id` (sin dependencias de Node).
 *
 * Los usa el logger del servidor, el instrumentation de Next (que también corre
 * en Edge) y el cliente HTTP del navegador. El id solo se acepta si tiene una
 * forma segura: así no se propaga basura ni se permite inyectar texto en los
 * logs o en el tag de Sentry.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** ¿El valor tiene forma de request-id seguro? */
export function isValidRequestId(value: string | null | undefined): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed && REQUEST_ID_PATTERN.test(trimmed));
}

/** Devuelve el id normalizado o `undefined` si no es válido. */
export function normalizeRequestId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return isValidRequestId(trimmed) ? trimmed : undefined;
}

/**
 * Acepta `Headers`, un `Request`/`NextRequest` o el objeto de headers que
 * entrega el hook `onRequestError` de Next.
 */
export type HeaderBag =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

/** Primer valor de un header, sin importar mayúsculas/minúsculas. */
export function headerValue(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value ?? undefined;
  }

  const record = headers as Record<string, string | string[] | undefined>;
  const direct = record[name];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;

  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

/** Request-id recibido en los headers, solo si es válido. */
export function requestIdFromHeaders(headers: HeaderBag): string | undefined {
  return normalizeRequestId(headerValue(headers, REQUEST_ID_HEADER));
}
