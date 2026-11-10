/**
 * Persistencia local del control post-factura que no pudo enviarse.
 *
 * Cuando el PATCH falla por red o timeout, la UI conserva el estado optimista
 * y guarda acá los cambios por usuario y pedido. El detalle de facturación los
 * reintenta al recuperar conexión, con el botón "Reintentar ahora" o antes de
 * cerrar el pedido. El snapshot sobrevive a una recarga o al cierre de la app.
 *
 * El módulo es puro (storage inyectado), tolera datos corruptos y un storage
 * bloqueado: nunca lanza y devuelve `null`/`false` cuando no puede operar.
 */
import { POST_CONTROL_VALUES, type PostControl } from './order-post-control';

/** Prefijo de la clave; la clave final incluye usuario y pedido. */
export const POST_CONTROL_PENDING_STORAGE_KEY = 'sgi_post_control_pending';

/** Un lote sin sincronizar deja de reintentarse después de este tiempo. */
export const POST_CONTROL_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Margen para tolerar relojes adelantados sin aceptar fechas absurdas. */
const MAX_CLOCK_SKEW_MS = 60 * 1000;

export interface PostControlPendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PostControlPendingSnapshot {
  orderId: string;
  userId: string;
  /** Versión del pedido usada en el último PATCH fallido. */
  version: number;
  /** Epoch ms del último guardado local. */
  savedAt: number;
  /** Último control elegido por el operario, por línea. */
  items: Record<string, PostControl>;
  /** Valor que tenía la línea antes del primer cambio local, para rollback. */
  previous: Record<string, PostControl>;
}

export interface PostControlPendingChange {
  itemId: string;
  postControl: PostControl;
  /** Valor anterior al cambio; se conserva sólo la primera vez por línea. */
  previous: PostControl;
}

export interface PostControlPendingQuery {
  orderId: string;
  userId: string;
  now?: number;
  ttlMs?: number;
}

export interface MergePostControlPendingInput {
  orderId: string;
  userId: string;
  version: number;
  changes: readonly PostControlPendingChange[];
  savedAt?: number;
}

/** Clave de storage del control pendiente de un usuario para un pedido. */
export function getPostControlPendingStorageKey(userId: string, orderId: string): string {
  return `${POST_CONTROL_PENDING_STORAGE_KEY}:${userId.trim()}:${orderId.trim()}`;
}

function storageKeyFor(
  userId: string | null | undefined,
  orderId: string | null | undefined,
): string | null {
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (typeof orderId !== 'string' || !orderId.trim()) return null;
  return getPostControlPendingStorageKey(userId, orderId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePostControl(value: unknown): PostControl | null {
  return (POST_CONTROL_VALUES as readonly unknown[]).includes(value)
    ? (value as PostControl)
    : null;
}

function sanitizeControlRecord(value: unknown): Record<string, PostControl> {
  if (!isRecord(value)) return {};

  const controls: Record<string, PostControl> = {};

  for (const [itemId, rawControl] of Object.entries(value)) {
    const control = normalizePostControl(rawControl);
    if (!itemId.trim() || !control) continue;
    controls[itemId] = control;
  }

  return controls;
}

/** Parsea y sanea un snapshot guardado. Devuelve `null` si no es utilizable. */
export function parsePostControlPending(raw: string | null): PostControlPendingSnapshot | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (typeof parsed.orderId !== 'string' || !parsed.orderId.trim()) return null;
  if (typeof parsed.userId !== 'string' || !parsed.userId.trim()) return null;
  if (
    typeof parsed.version !== 'number' ||
    !Number.isFinite(parsed.version) ||
    parsed.version < 0
  ) {
    return null;
  }
  if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null;

  const items = sanitizeControlRecord(parsed.items);
  if (Object.keys(items).length === 0) return null;

  const rawPrevious = sanitizeControlRecord(parsed.previous);
  const previous: Record<string, PostControl> = {};
  for (const itemId of Object.keys(items)) {
    // Si el snapshot viejo no guardó el valor previo, el rollback más seguro
    // es dejar la línea como pendiente (nunca marcarla OK por accidente).
    previous[itemId] = rawPrevious[itemId] ?? 'pendiente';
  }

  return {
    orderId: parsed.orderId.trim(),
    userId: parsed.userId.trim(),
    version: Math.floor(parsed.version),
    savedAt: Math.floor(parsed.savedAt),
    items,
    previous,
  };
}

/**
 * Guarda el snapshot completo. Devuelve `false` si el storage no está
 * disponible o el snapshot no tiene cambios válidos.
 */
export function savePostControlPending(
  storage: PostControlPendingStorage | null | undefined,
  snapshot: PostControlPendingSnapshot,
): boolean {
  const key = storageKeyFor(snapshot.userId, snapshot.orderId);
  if (!storage || !key) return false;
  if (Object.keys(snapshot.items).length === 0) return false;

  try {
    storage.setItem(
      key,
      JSON.stringify({
        orderId: snapshot.orderId.trim(),
        userId: snapshot.userId.trim(),
        version:
          Number.isFinite(snapshot.version) && snapshot.version >= 0
            ? Math.floor(snapshot.version)
            : 0,
        savedAt: Number.isFinite(snapshot.savedAt) ? Math.floor(snapshot.savedAt) : Date.now(),
        items: snapshot.items,
        previous: snapshot.previous,
      } satisfies PostControlPendingSnapshot),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Lee el snapshot si pertenece al usuario/pedido y no venció. Un storage
 * inaccesible o un dato corrupto cuenta como vacío.
 */
export function loadPostControlPending(
  storage: PostControlPendingStorage | null | undefined,
  query: PostControlPendingQuery,
): PostControlPendingSnapshot | null {
  const key = storageKeyFor(query.userId, query.orderId);
  if (!storage || !key) return null;

  let snapshot: PostControlPendingSnapshot | null = null;
  try {
    snapshot = parsePostControlPending(storage.getItem(key));
  } catch {
    return null;
  }

  if (!snapshot) return null;
  if (snapshot.userId !== query.userId.trim() || snapshot.orderId !== query.orderId.trim()) {
    return null;
  }

  const now = query.now ?? Date.now();
  const ttlMs = query.ttlMs ?? POST_CONTROL_PENDING_TTL_MS;

  if (snapshot.savedAt > now + MAX_CLOCK_SKEW_MS) return null;
  if (now - snapshot.savedAt >= ttlMs) return null;

  return snapshot;
}

/**
 * Fusiona un lote fallido con lo que ya estaba pendiente. El `previous` de
 * cada línea se conserva desde el primer cambio para que un rollback posterior
 * vuelva al valor que vio el operario. Si el ida y vuelta deja la línea como
 * estaba en el servidor, se elimina del snapshot.
 */
export function mergePostControlPending(
  storage: PostControlPendingStorage | null | undefined,
  input: MergePostControlPendingInput,
): PostControlPendingSnapshot | null {
  const key = storageKeyFor(input.userId, input.orderId);
  if (!storage || !key) return null;

  let existing: PostControlPendingSnapshot | null = null;
  try {
    existing = parsePostControlPending(storage.getItem(key));
  } catch {
    existing = null;
  }

  if (
    existing &&
    (existing.userId !== input.userId.trim() || existing.orderId !== input.orderId.trim())
  ) {
    existing = null;
  }

  const items: Record<string, PostControl> = { ...(existing?.items ?? {}) };
  const previous: Record<string, PostControl> = { ...(existing?.previous ?? {}) };

  for (const change of input.changes) {
    const itemId = typeof change.itemId === 'string' ? change.itemId.trim() : '';
    const postControl = normalizePostControl(change.postControl);
    if (!itemId || !postControl) continue;

    const original = previous[itemId] ?? normalizePostControl(change.previous) ?? 'pendiente';

    if (postControl === original) {
      delete items[itemId];
      delete previous[itemId];
      continue;
    }

    previous[itemId] = original;
    items[itemId] = postControl;
  }

  if (Object.keys(items).length === 0) {
    try {
      storage.removeItem(key);
    } catch {
      // Sin storage no hay snapshot que borrar.
    }
    return null;
  }

  const version = Number.isFinite(input.version) && input.version >= 0 ? input.version : 0;
  const snapshot: PostControlPendingSnapshot = {
    orderId: input.orderId.trim(),
    userId: input.userId.trim(),
    version: Math.max(existing?.version ?? 0, Math.floor(version)),
    savedAt:
      typeof input.savedAt === 'number' && Number.isFinite(input.savedAt)
        ? Math.floor(input.savedAt)
        : Date.now(),
    items,
    previous,
  };

  return savePostControlPending(storage, snapshot) ? snapshot : null;
}

/** Elimina el snapshot al sincronizarlo, descartarlo o al cerrar sesión. */
export function clearPostControlPending(
  storage: PostControlPendingStorage | null | undefined,
  userId: string | null | undefined,
  orderId: string | null | undefined,
): boolean {
  const key = storageKeyFor(userId, orderId);
  if (!storage || !key) return false;

  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Lista las claves del storage tolerando implementaciones parciales. */
function listStorageKeys(storage: PostControlPendingStorage): string[] {
  const keys = new Set<string>();
  const storageLike = storage as PostControlPendingStorage & {
    length?: unknown;
    key?: (index: number) => string | null;
    keys?: () => Iterable<string>;
    values?: unknown;
  };

  if (typeof storageLike.length === 'number' && typeof storageLike.key === 'function') {
    for (let index = 0; index < storageLike.length; index += 1) {
      const key = storageLike.key(index);
      if (typeof key === 'string') keys.add(key);
    }
  }

  if (typeof storageLike.keys === 'function') {
    for (const key of storageLike.keys()) {
      if (typeof key === 'string') keys.add(key);
    }
  }

  if (storageLike.values instanceof Map) {
    for (const key of storageLike.values.keys()) {
      if (typeof key === 'string') keys.add(key);
    }
  }

  for (const key of Object.keys(storage)) {
    if (key !== 'values') keys.add(key);
  }

  return [...keys];
}

/**
 * Quita del snapshot las líneas que ya se sincronizaron por otra vía (por
 * ejemplo, un nuevo toque que sí llegó al servidor). Evita que un reintento
 * posterior reaplique un valor viejo sobre el guardado. Si no queda ninguna
 * línea, elimina la clave y devuelve `null`.
 */
export function removePostControlPendingItems(
  storage: PostControlPendingStorage | null | undefined,
  userId: string,
  orderId: string,
  itemIds: readonly string[],
  options: { version?: number; savedAt?: number } = {},
): PostControlPendingSnapshot | null {
  const key = storageKeyFor(userId, orderId);
  if (!storage || !key || itemIds.length === 0) return null;

  let snapshot: PostControlPendingSnapshot | null = null;
  try {
    snapshot = parsePostControlPending(storage.getItem(key));
  } catch {
    return null;
  }

  if (!snapshot) return null;
  if (snapshot.userId !== userId.trim() || snapshot.orderId !== orderId.trim()) return null;

  let changed = false;
  for (const rawItemId of itemIds) {
    const itemId = rawItemId.trim();
    if (!itemId) continue;
    if (snapshot.items[itemId] === undefined && snapshot.previous[itemId] === undefined) continue;

    delete snapshot.items[itemId];
    delete snapshot.previous[itemId];
    changed = true;
  }

  if (!changed) return snapshot;

  if (Object.keys(snapshot.items).length === 0) {
    try {
      storage.removeItem(key);
    } catch {
      // Sin storage no hay snapshot que borrar.
    }
    return null;
  }

  const next: PostControlPendingSnapshot = {
    ...snapshot,
    version:
      typeof options.version === 'number' && Number.isFinite(options.version)
        ? Math.max(snapshot.version, Math.floor(options.version))
        : snapshot.version,
    savedAt:
      typeof options.savedAt === 'number' && Number.isFinite(options.savedAt)
        ? Math.floor(options.savedAt)
        : Date.now(),
  };

  return savePostControlPending(storage, next) ? next : null;
}

/**
 * Borra todos los controles post-factura pendientes de este dispositivo. Se
 * usa en el logout, igual que los borradores y comentarios pendientes.
 */
export function clearAllPostControlPending(
  storage: PostControlPendingStorage | null | undefined,
): number {
  if (!storage) return 0;

  let removed = 0;
  try {
    for (const key of listStorageKeys(storage)) {
      if (!key.startsWith(`${POST_CONTROL_PENDING_STORAGE_KEY}:`)) continue;
      storage.removeItem(key);
      removed += 1;
    }
  } catch {
    // Storage bloqueado: no hay snapshots que borrar.
  }

  return removed;
}
