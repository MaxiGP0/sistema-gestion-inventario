/**
 * Rate limiting en memoria para endpoints costosos.
 *
 * La interfaz `consume(key, { limit, windowMs })` es deliberadamente chica y
 * no conoce HTTP: hoy usa una ventana fija por clave en un `Map` colgado de
 * `globalThis` (mismo patrón que el login, sobrevive al HMR de `next dev`).
 *
 * Limitación multi-instancia: cada proceso Node tiene su propio contador. Si
 * la app pasa a varias instancias/serverless, reemplazar la implementación de
 * `consume` por un adaptador compartido (Redis con TTL o MongoDB con upsert
 * atómico). Las rutas no cambian porque sólo dependen de esta interfaz.
 * Ver docs/seguridad-cabeceras.md §5.
 */

import { NextResponse } from 'next/server';

export interface ApiRateLimitOptions {
  /** Solicitudes permitidas dentro de la ventana. */
  limit: number;
  /** Duración de la ventana en milisegundos. */
  windowMs: number;
}

export interface ApiRateLimitResult {
  allowed: boolean;
  /** Segundos restantes hasta que la clave vuelva a tener cupo. */
  retryAfterSeconds: number;
}

export const API_RATE_LIMIT_RULES = {
  ordersExport: { limit: 10, windowMs: 60_000 },
  catalogImport: { limit: 5, windowMs: 60_000 },
  ordersSearch: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, ApiRateLimitOptions>;

export type ApiRateLimitScope = keyof typeof API_RATE_LIMIT_RULES;

interface RateLimitRecord {
  count: number;
  windowStartedAt: number;
}

declare global {
  var apiRateLimitStore: Map<string, RateLimitRecord> | undefined;
}

/** Tope de claves guardadas; al superarlo se purgan las ventanas vencidas. */
const MAX_TRACKED_KEYS = 5_000;

const store = globalThis.apiRateLimitStore ?? new Map<string, RateLimitRecord>();
globalThis.apiRateLimitStore = store;

function pruneExpired(now: number, windowMs: number): void {
  for (const [key, record] of store) {
    if (now - record.windowStartedAt >= windowMs) store.delete(key);
  }
}

/**
 * Consume un cupo de la clave. Devuelve `allowed: false` y los segundos para
 * reintentar cuando la ventana ya está agotada.
 */
export function consume(
  key: string,
  { limit, windowMs }: ApiRateLimitOptions,
  now = Date.now(),
): ApiRateLimitResult {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const safeWindowMs = Math.max(1, Math.trunc(windowMs));

  if (store.size >= MAX_TRACKED_KEYS) pruneExpired(now, safeWindowMs);

  const record = store.get(key);
  if (!record || now - record.windowStartedAt >= safeWindowMs) {
    store.set(key, { count: 1, windowStartedAt: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (record.count >= safeLimit) {
    const remainingMs = record.windowStartedAt + safeWindowMs - now;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
  }

  record.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Clave estable por alcance y usuario autenticado (nunca por IP/header). */
export function apiRateLimitKey(scope: ApiRateLimitScope | string, userId: string): string {
  return `${scope}:user:${userId}`;
}

/** Respuesta 429 homogénea para las rutas caras. */
export function rateLimitResponse(
  result: ApiRateLimitResult,
  message = 'Demasiadas solicitudes. Intentá de nuevo más tarde.',
): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, result.retryAfterSeconds)) },
    },
  );
}

/** Vacía el store compartido. Solo para pruebas. */
export function resetApiRateLimits(): void {
  store.clear();
}
