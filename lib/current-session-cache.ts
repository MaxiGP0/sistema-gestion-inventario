/**
 * Caché en memoria del estado actual del usuario para `requireCurrentSession`.
 *
 * La cookie firmada no puede invalidarse sola: entre el login y el vencimiento
 * (8 h) el rol, `active` o `sessionVersion` pueden cambiar en la base. Leer el
 * usuario en cada request de escritura agregaría una consulta a Mongo por
 * operación; este caché acota ese costo a una lectura cada 30-60 s.
 *
 * Las mutaciones de usuarios llaman a `invalidateCurrentSessionCache`, de modo
 * que un cambio de rol, una baja o un reset de contraseña se aplican en la
 * siguiente petición, sin esperar el TTL ni las 8 h de la cookie.
 */

import type { UserRole } from './authz';

/** TTL por defecto: 45 s (dentro del rango pedido de 30-60 s). */
export const DEFAULT_CURRENT_SESSION_CACHE_TTL_SECONDS = 45;

const MIN_CACHE_TTL_SECONDS = 30;
const MAX_CACHE_TTL_SECONDS = 60;

export interface CurrentSessionSnapshot {
  userId: string;
  username: string;
  role: UserRole;
  active: boolean;
  sessionVersion: number;
  notificationsEnabled: boolean;
  /** Marca de tiempo (ms) en la que la entrada deja de ser confiable. */
  expiresAt: number;
}

type CurrentSessionSeed = Omit<CurrentSessionSnapshot, 'expiresAt'>;

interface CurrentSessionCacheState {
  entries: Map<string, CurrentSessionSnapshot>;
}

declare global {
  var sgiCurrentSessionCache: CurrentSessionCacheState | undefined;
}

/**
 * El Map vive en `globalThis` por la misma razón que el bus SSE: en Next cada
 * route handler es un entrypoint independiente y puede quedarse con su propia
 * copia de este módulo. Si cada copia tuviera su propio Map, la invalidación
 * de `/api/users` no llegaría al heartbeat de `/api/events` y la revocación
 * quedaría sólo a merced del TTL. El singleton de proceso mantiene una única
 * fuente para todas las rutas.
 */
const state: CurrentSessionCacheState = global.sgiCurrentSessionCache ?? {
  entries: new Map<string, CurrentSessionSnapshot>(),
};
if (!global.sgiCurrentSessionCache) {
  global.sgiCurrentSessionCache = state;
}

const cache = state.entries;

/** TTL efectivo; `AUTH_SESSION_CACHE_TTL_SECONDS` se limita a 30-60 s. */
export function getCurrentSessionCacheTtlMs(): number {
  const configured = Number(process.env.AUTH_SESSION_CACHE_TTL_SECONDS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_CURRENT_SESSION_CACHE_TTL_SECONDS * 1000;
  }

  const seconds = Math.min(
    MAX_CACHE_TTL_SECONDS,
    Math.max(MIN_CACHE_TTL_SECONDS, Math.trunc(configured)),
  );

  return seconds * 1000;
}

/** Entrada vigente del caché, o `null` si no existe o ya venció. */
export function getCachedCurrentSession(
  userId: string,
  now = Date.now(),
): CurrentSessionSnapshot | null {
  const entry = cache.get(userId);

  if (!entry) return null;

  if (entry.expiresAt <= now) {
    cache.delete(userId);
    return null;
  }

  return entry;
}

/** Guarda/refresca el estado actual del usuario (también se usa tras el login). */
export function primeCurrentSessionCache(
  snapshot: CurrentSessionSeed,
  now = Date.now(),
): CurrentSessionSnapshot {
  const entry: CurrentSessionSnapshot = {
    ...snapshot,
    expiresAt: now + getCurrentSessionCacheTtlMs(),
  };

  cache.set(snapshot.userId, entry);
  return entry;
}

/** Invalida un usuario o, sin argumento, todo el caché (tests/operaciones masivas). */
export function invalidateCurrentSessionCache(userId?: string): void {
  if (userId === undefined) {
    cache.clear();
    return;
  }

  cache.delete(userId);
}

/** Solo para tests: deja el caché limpio entre escenarios. */
export function resetCurrentSessionCache(): void {
  cache.clear();
}
