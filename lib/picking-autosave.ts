/**
 * Autosave local del picking (localStorage).
 *
 * Guarda un snapshot del control por pedido y usuario para sobrevivir a una
 * recarga o a la app cerrada en el depósito. El snapshot sólo se ofrece si
 * pertenece a la misma versión del pedido y tiene menos de 24 h: si otro
 * operario ya guardó una versión más nueva, restaurarlo pisaría su trabajo.
 *
 * El módulo es tolerante a datos corruptos y a un storage bloqueado (modo
 * privado): nunca lanza y devuelve `null`/`false` cuando no puede operar.
 */
import { pickingItemKey, type ItemControlState, type PickingState } from './picking-control';

/** Prefijo de la clave; la clave final incluye usuario y pedido. */
export const PICKING_AUTOSAVE_STORAGE_KEY = 'sgi_picking_autosave';

/** Un control sin guardar deja de ofrecerse después de este tiempo. */
export const PICKING_AUTOSAVE_TTL_MS = 24 * 60 * 60 * 1000;

/** Margen para tolerar relojes adelantados sin aceptar fechas absurdas. */
const MAX_CLOCK_SKEW_MS = 60 * 1000;

export interface PickingAutosaveSnapshot {
  orderId: string;
  userId: string;
  /** Versión del pedido leída cuando se empezó a controlar. */
  version: number;
  /** Epoch ms del último autosave. */
  savedAt: number;
  items: PickingState;
  /**
   * Comentario que no pudo enviarse por falta de red/timeout. Se conserva para
   * mostrarlo al reabrir el pedido y enviarlo con el próximo PUT de picking.
   */
  pendingComment?: string;
}

export interface PickingAutosaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PickingAutosaveQuery {
  orderId: string;
  userId: string;
  /** Versión actual del pedido: sólo se restaura si coincide. */
  version: number;
  now?: number;
  ttlMs?: number;
}

/** Clave de storage del picking de un usuario para un pedido. */
export function getPickingAutosaveStorageKey(userId: string, orderId: string): string {
  return `${PICKING_AUTOSAVE_STORAGE_KEY}:${userId.trim()}:${orderId.trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizePendingComment(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 2000) : '';
}

function sanitizeState(value: unknown): PickingState {
  if (!isRecord(value)) return {};

  const state: PickingState = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!key || !isRecord(raw)) continue;

    const verifiedQty = raw.verifiedQty;
    const controlled = raw.controlled;
    if (
      typeof verifiedQty !== 'number' ||
      !Number.isFinite(verifiedQty) ||
      verifiedQty < 0 ||
      typeof controlled !== 'boolean'
    ) {
      continue;
    }

    const pendingReason = typeof raw.pendingReason === 'string' ? raw.pendingReason : '';

    const entry: ItemControlState = {
      verifiedQty: Math.floor(verifiedQty),
      controlled,
      pendingReason: pendingReason.slice(0, 200),
    };
    state[key] = entry;
  }

  return state;
}

export interface PickingAutosaveFromOrderPutInput {
  orderId: string;
  userId: string;
  /** Versión vigente del pedido leída del servidor al rescatar el control. */
  version: number;
  /** `body.items` de la entrada fallida de la cola offline. */
  items: unknown;
  savedAt?: number;
}

function orderPutItemKey(item: Record<string, unknown>): string {
  const itemId = typeof item._id === 'string' ? item._id.trim() : '';
  if (itemId) return itemId;

  const rawProductId = item.productId;
  const productId =
    typeof rawProductId === 'string'
      ? rawProductId.trim()
      : isRecord(rawProductId) && typeof rawProductId._id === 'string'
        ? rawProductId._id.trim()
        : '';

  return pickingItemKey({
    productId: productId ? { _id: productId } : null,
    productName: typeof item.productName === 'string' ? item.productName : undefined,
    productCode: typeof item.productCode === 'string' ? item.productCode : undefined,
    requestedQuantity: 0,
  });
}

/**
 * Reconstruye el autosave del picking desde el `body.items` de un PUT que el
 * servidor rechazó (por ejemplo, 409 de versión). La versión debe ser la
 * vigente del servidor para que el detalle ofrezca restaurarlo; las cantidades
 * y motivos salen del intento original del operario.
 */
export function buildPickingAutosaveFromOrderPut(
  input: PickingAutosaveFromOrderPutInput,
): PickingAutosaveSnapshot | null {
  const orderId = input.orderId.trim();
  const userId = input.userId.trim();
  if (!orderId || !userId) return null;
  if (!Array.isArray(input.items)) return null;
  if (typeof input.version !== 'number' || !Number.isFinite(input.version) || input.version < 0) {
    return null;
  }

  const items: PickingState = {};

  for (const raw of input.items) {
    if (!isRecord(raw)) continue;

    const verifiedQty = raw.verifiedQuantity ?? raw.verifiedQty;
    if (typeof verifiedQty !== 'number' || !Number.isFinite(verifiedQty) || verifiedQty < 0) {
      continue;
    }

    const key = orderPutItemKey(raw);
    if (!key) continue;

    const isPending = typeof raw.isPending === 'boolean' ? raw.isPending : undefined;
    const entry: ItemControlState = {
      verifiedQty: Math.floor(verifiedQty),
      controlled: isPending === undefined ? verifiedQty > 0 : !isPending,
      pendingReason: typeof raw.pendingReason === 'string' ? raw.pendingReason.slice(0, 200) : '',
    };
    items[key] = entry;
  }

  if (Object.keys(items).length === 0) return null;

  return {
    orderId,
    userId,
    version: Math.floor(input.version),
    savedAt:
      typeof input.savedAt === 'number' && Number.isFinite(input.savedAt)
        ? Math.floor(input.savedAt)
        : Date.now(),
    items,
  };
}

/** Parsea y sanea un snapshot guardado. Devuelve `null` si no es utilizable. */
export function parsePickingAutosave(raw: string | null): PickingAutosaveSnapshot | null {
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

  const items = sanitizeState(parsed.items);
  const pendingComment = sanitizePendingComment(parsed.pendingComment);
  if (Object.keys(items).length === 0 && !pendingComment) return null;

  return {
    orderId: parsed.orderId.trim(),
    userId: parsed.userId.trim(),
    version: Math.floor(parsed.version),
    savedAt: Math.floor(parsed.savedAt),
    items,
    ...(pendingComment ? { pendingComment } : {}),
  };
}

function storageKeyFor(
  userId: string | null | undefined,
  orderId: string | null | undefined,
): string | null {
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (typeof orderId !== 'string' || !orderId.trim()) return null;
  return getPickingAutosaveStorageKey(userId, orderId);
}

/**
 * Guarda el snapshot sólo si no pisa uno de una versión más nueva del pedido.
 * Devuelve `false` si el storage no está disponible o el guardado se omitió.
 */
export function savePickingAutosave(
  storage: PickingAutosaveStorage | null | undefined,
  snapshot: PickingAutosaveSnapshot,
): boolean {
  const key = storageKeyFor(snapshot.userId, snapshot.orderId);
  if (!storage || !key) return false;

  try {
    const existing = parsePickingAutosave(storage.getItem(key));
    if (existing && existing.version > snapshot.version) return false;

    storage.setItem(key, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lee el snapshot si corresponde restaurarlo: mismo usuario, mismo pedido,
 * misma versión y menos de 24 h de antigüedad.
 */
export function loadPickingAutosave(
  storage: PickingAutosaveStorage | null | undefined,
  query: PickingAutosaveQuery,
): PickingAutosaveSnapshot | null {
  const key = storageKeyFor(query.userId, query.orderId);
  if (!storage || !key) return null;

  let snapshot: PickingAutosaveSnapshot | null = null;
  try {
    snapshot = parsePickingAutosave(storage.getItem(key));
  } catch {
    return null;
  }

  if (!snapshot) return null;
  if (snapshot.userId !== query.userId || snapshot.orderId !== query.orderId) return null;
  if (snapshot.version !== Math.floor(query.version)) return null;

  const now = query.now ?? Date.now();
  const ttlMs = query.ttlMs ?? PICKING_AUTOSAVE_TTL_MS;

  if (snapshot.savedAt > now + MAX_CLOCK_SKEW_MS) return null;
  if (now - snapshot.savedAt >= ttlMs) return null;

  return snapshot;
}

/** Elimina el autosave al guardar, encolar o descartar el control. */
export function clearPickingAutosave(
  storage: PickingAutosaveStorage | null | undefined,
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

/**
 * Quita sólo el comentario pendiente y conserva el control sin guardar.
 * Si el snapshot quedó vacío (sin líneas ni comentario), elimina la clave.
 */
export function clearPickingAutosaveComment(
  storage: PickingAutosaveStorage | null | undefined,
  userId: string | null | undefined,
  orderId: string | null | undefined,
): boolean {
  const key = storageKeyFor(userId, orderId);
  if (!storage || !key) return false;

  try {
    const snapshot = parsePickingAutosave(storage.getItem(key));
    if (!snapshot?.pendingComment) return false;

    const rest: PickingAutosaveSnapshot = { ...snapshot };
    delete rest.pendingComment;

    if (Object.keys(rest.items).length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(rest));
    }
    return true;
  } catch {
    return false;
  }
}
