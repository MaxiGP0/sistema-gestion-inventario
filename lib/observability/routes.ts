/**
 * Normalización de rutas para métricas y tags.
 *
 * Sin esto, `/api/orders/64f.../` y `/api/orders/650.../` serían dos series
 * distintas y multiplicarían la cardinalidad de las métricas. Se reemplazan
 * los segmentos con forma de ObjectId, UUID, número o token largo por `[id]`.
 * No se conservan query strings ni fragmentos.
 */

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_PATTERN = /^\d{1,20}$/;
const LONG_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

/** Quita query/hash y reemplaza identificadores por `[id]`. */
export function normalizeRoute(pathname: string): string {
  const withoutQuery = (pathname || '/').split(/[?#]/, 1)[0] || '/';
  const absolute = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;

  const normalized = absolute
    .split('/')
    .map((segment) => {
      if (!segment) return segment;

      if (
        OBJECT_ID_PATTERN.test(segment) ||
        UUID_PATTERN.test(segment) ||
        NUMERIC_PATTERN.test(segment) ||
        LONG_TOKEN_PATTERN.test(segment)
      ) {
        return '[id]';
      }

      return segment;
    })
    .join('/');

  if (normalized.length <= 1) return '/';
  return normalized.replace(/\/+$/, '') || '/';
}

/** Normaliza una URL absoluta o relativa; si no se puede parsear, usa `/`. */
export function routeFromUrl(url: string, base = 'http://localhost'): string {
  try {
    return normalizeRoute(new URL(url, base).pathname);
  } catch {
    return '/';
  }
}
