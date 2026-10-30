/**
 * Redacción de datos sensibles para logs y Sentry.
 *
 * Regla del proyecto: nunca se envían cuerpos de request/response, contraseñas,
 * cookies, tokens ni query strings con datos personales. Esta capa es la última
 * defensa: aunque una integración agregue un campo por su cuenta, antes de
 * salir se elimina o se reemplaza por `[REDACTED]`.
 *
 * Es pura (sin Node ni Sentry) para poder probarla y usarla en cliente, servidor
 * y Edge.
 */

export const REDACTED = '[REDACTED]';

/**
 * Claves que nunca deben salir. Se comparan por nombre completo o por segmento
 * (`user_password`, `passwordHash`, etc.).
 */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|authorization|cookie|session|api[-_]?key|credential|(^|[._-])(body|payload)([._-]|$)|requestBody|responseBody|email|phone|dni|cuit)/i;

/** Patrones de secretos embebidos en textos (mensajes de error, stacks, etc.). */
const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [
    /((?:password|passwd|pwd|token|secret|authorization|cookie|session|api[-_]?key)\s*[=:]\s*)([^\s,;&"'}\]]+)/gi,
    `$1${REDACTED}`,
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
];

/** Headers que sí se conservan en Sentry (sin IP ni credenciales). */
const SAFE_HEADER_NAMES = new Set([
  'x-request-id',
  'user-agent',
  'content-type',
  'accept',
  'accept-language',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Redacta asignaciones de secretos dentro de un texto libre. */
export function redactText(value: string): string {
  return SECRET_TEXT_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

/** URL sin query string ni fragmento (evita filtraciones por parámetros). */
export function scrubUrl(url: string): string {
  if (!url) return url;

  const withoutHash = url.split('#', 1)[0] || '';
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutHash);

  if (!isAbsolute) {
    return withoutHash.split('?', 1)[0] || '';
  }

  try {
    const parsed = new URL(withoutHash);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return withoutHash.split('?', 1)[0] || '';
  }
}

/**
 * Copia recursiva de un valor con claves sensibles y textos redactados.
 * Las referencias circulares se cortan con `[Circular]`.
 */
export function redactValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > 8) return '[Truncated]';
  if (typeof value === 'string') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return scrubUrl(value);
    return redactText(value);
  }
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
    };
  }

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(source)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }

  return result;
}

/** Campos de un log estructurado, sin secretos ni cuerpos. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields) as Record<string, unknown>;
}

function pickSafeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers) return undefined;

  const entries: Array<[string, unknown]> = Array.isArray(headers)
    ? (headers as Array<[string, unknown]>)
    : Object.entries(headers as Record<string, unknown>);

  const safe: Record<string, string> = {};

  for (const [key, raw] of entries) {
    const name = String(key).toLowerCase();
    if (!SAFE_HEADER_NAMES.has(name)) continue;

    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' || typeof value === 'number') {
      safe[name] = String(value).slice(0, 512);
    }
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}

export interface ScrubbableRequest {
  url?: string;
  query_string?: unknown;
  data?: unknown;
  cookies?: unknown;
  headers?: unknown;
  env?: unknown;
  [key: string]: unknown;
}

export interface ScrubbableBreadcrumb {
  category?: string;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface ScrubbableSpan {
  description?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ScrubbableEvent {
  message?: string;
  request?: ScrubbableRequest;
  user?: unknown;
  extra?: unknown;
  contexts?: unknown;
  breadcrumbs?: unknown;
  exception?: {
    values?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Limpia un evento de Sentry antes de enviarlo. Se aplica siempre, incluso si
 * `sendDefaultPii: false` ya bloqueó la mayor parte.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const result: ScrubbableEvent = { ...event };

  if (result.request) {
    result.request = {
      ...result.request,
      ...(result.request.url ? { url: scrubUrl(result.request.url) } : {}),
      headers: pickSafeHeaders(result.request.headers),
      query_string: undefined,
      data: undefined,
      cookies: undefined,
      env: undefined,
    };
  }

  // La identidad del usuario no es necesaria para diagnosticar y puede ser PII.
  result.user = undefined;

  if (result.extra !== undefined) result.extra = redactValue(result.extra);
  if (result.contexts !== undefined) result.contexts = redactValue(result.contexts);
  if (result.message) result.message = redactText(result.message);

  if (Array.isArray(result.breadcrumbs)) {
    result.breadcrumbs = result.breadcrumbs.map((breadcrumb) =>
      scrubBreadcrumb(breadcrumb as ScrubbableBreadcrumb),
    );
  }

  const exceptionValues = result.exception?.values;
  if (Array.isArray(exceptionValues)) {
    result.exception = {
      ...result.exception,
      values: exceptionValues.map((entry) => {
        const clean = { ...entry };
        if (typeof clean.value === 'string') clean.value = redactText(clean.value);
        if (typeof clean.message === 'string') clean.message = redactText(clean.message);
        return clean;
      }),
    };
  }

  return result as T;
}

/** Limpia un breadcrumb: sin bodies, sin argumentos de consola ni query strings. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  const result: ScrubbableBreadcrumb = { ...breadcrumb };
  const category = breadcrumb.category?.toLowerCase();

  if (category === 'console') {
    // console.log(...) puede incluir cuerpos completos de request.
    delete result.data;
  } else if (category === 'fetch' || category === 'xhr' || category === 'http') {
    const source =
      breadcrumb.data && typeof breadcrumb.data === 'object'
        ? (breadcrumb.data as Record<string, unknown>)
        : {};

    result.data = {
      method: source.method,
      url: typeof source.url === 'string' ? scrubUrl(source.url) : undefined,
      status_code: source.status_code,
    };
  } else if (breadcrumb.data !== undefined) {
    result.data = redactValue(breadcrumb.data);
  }

  if (result.message) result.message = redactText(result.message);

  return result as T;
}

/** Limpia atributos de spans: sin statements SQL/NoSQL ni bodies. */
export function scrubSpan<T extends ScrubbableSpan>(span: T): T {
  const attributes = span.attributes;
  if (attributes) {
    for (const key of Object.keys(attributes)) {
      if (/^(db\.(query|statement)|http\.request\.body|http\.response\.body)/i.test(key)) {
        delete attributes[key];
      }
    }

    span.attributes = redactValue(attributes) as Record<string, unknown>;
  }

  if (span.description) span.description = redactText(span.description);

  return span;
}
