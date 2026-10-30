/**
 * Rate limiting básico en memoria para el login.
 *
 * Limita los intentos fallidos con una ventana fija por clave: una por IP de
 * origen y otra por usuario. Alcanza para el entorno actual (un solo proceso
 * Node); si la app pasara a correr en varias instancias o serverless, cada
 * una tendría su propio conteo y el límite se multiplicaría por instancia.
 * En ese caso hay que mover estas funciones a un store compartido (Redis con
 * TTL, o MongoDB con upsert atómico). Ver docs/seguridad-cabeceras.md §5.
 */

export const LOGIN_RATE_LIMIT = {
  /** Intentos fallidos permitidos dentro de la ventana. */
  maxAttempts: 5,
  /** Duración de la ventana en milisegundos. */
  windowMs: 15 * 60 * 1000,
  /** Tope de claves guardadas; al superarlo se purgan las vencidas. */
  maxTrackedKeys: 1000,
} as const;

interface AttemptRecord {
  count: number;
  windowStartedAt: number;
}

declare global {
  var loginRateLimitStore: Map<string, AttemptRecord> | undefined;
}

// El store cuelga de globalThis para sobrevivir a los recargados en caliente
// de `next dev` (mismo motivo que la conexión cacheada de mongoose).
const store = globalThis.loginRateLimitStore ?? new Map<string, AttemptRecord>();
globalThis.loginRateLimitStore = store;

/** IP de origen según los headers de proxy; 'desconocida' si no hay ninguno. */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0].trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'desconocida';
}

export function ipRateLimitKey(ip: string): string {
  return `ip:${ip}`;
}

/** Normaliza el usuario para que " Admin " y "admin" compartan la misma clave. */
export function userRateLimitKey(username: string): string {
  return `user:${username.trim().toLowerCase()}`;
}

/** Indica si la clave ya agotó los intentos de la ventana vigente. */
export function isRateLimited(key: string, now = Date.now()): boolean {
  const record = store.get(key);
  if (!record) return false;

  if (now - record.windowStartedAt >= LOGIN_RATE_LIMIT.windowMs) {
    store.delete(key);
    return false;
  }

  return record.count >= LOGIN_RATE_LIMIT.maxAttempts;
}

/** Suma un intento fallido; si la ventana venció, arranca una nueva. */
export function recordFailedAttempt(key: string, now = Date.now()): void {
  if (store.size >= LOGIN_RATE_LIMIT.maxTrackedKeys) {
    pruneExpired(now);
  }

  const record = store.get(key);
  if (!record || now - record.windowStartedAt >= LOGIN_RATE_LIMIT.windowMs) {
    store.set(key, { count: 1, windowStartedAt: now });
    return;
  }

  record.count += 1;
}

/** Limpia la clave (p. ej. tras un login exitoso). */
export function resetAttempts(key: string): void {
  store.delete(key);
}

/** Segundos que faltan para que la clave se desbloquee; 0 si no está bloqueada. */
export function getRetryAfterSeconds(key: string, now = Date.now()): number {
  const record = store.get(key);
  if (!record) return 0;

  const remainingMs = record.windowStartedAt + LOGIN_RATE_LIMIT.windowMs - now;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/** Vacía el store compartido. Solo para pruebas. */
export function resetAllAttempts(): void {
  store.clear();
}

function pruneExpired(now: number): void {
  for (const [key, record] of store) {
    if (now - record.windowStartedAt >= LOGIN_RATE_LIMIT.windowMs) {
      store.delete(key);
    }
  }
}
