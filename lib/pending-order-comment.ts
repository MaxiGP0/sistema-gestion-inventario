/**
 * Borrador local de un comentario de facturación que no pudo enviarse.
 *
 * Se guarda por usuario y pedido en localStorage para sobrevivir a una recarga
 * o al cierre de la app. El detalle lo muestra en el textarea y lo reintenta al
 * guardar el estado o al recuperar conexión. Nunca lanza: un storage bloqueado
 * simplemente no persiste.
 */

export const PENDING_ORDER_COMMENT_STORAGE_KEY = 'sgi_pending_order_comment';

const MAX_COMMENT_LENGTH = 2000;

export interface PendingOrderCommentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingOrderCommentDraft {
  orderId: string;
  userId: string;
  text: string;
  /** Epoch ms del último guardado local. */
  savedAt: number;
}

/** Clave de storage del comentario pendiente de un usuario para un pedido. */
export function getPendingOrderCommentStorageKey(userId: string, orderId: string): string {
  return `${PENDING_ORDER_COMMENT_STORAGE_KEY}:${userId.trim()}:${orderId.trim()}`;
}

function storageKeyFor(
  userId: string | null | undefined,
  orderId: string | null | undefined,
): string | null {
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (typeof orderId !== 'string' || !orderId.trim()) return null;
  return getPendingOrderCommentStorageKey(userId, orderId);
}

function sanitizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_COMMENT_LENGTH) : '';
}

/** Parsea y sanea un borrador guardado. Devuelve `null` si no es utilizable. */
export function parsePendingOrderComment(raw: string | null): PendingOrderCommentDraft | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const orderId = typeof record.orderId === 'string' ? record.orderId.trim() : '';
  const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const text = sanitizeText(record.text);
  const savedAt = record.savedAt;

  if (!orderId || !userId || !text) return null;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;

  return {
    orderId,
    userId,
    text,
    savedAt: Math.floor(savedAt),
  };
}

/** Guarda el borrador. Devuelve `false` si el storage no está disponible. */
export function savePendingOrderComment(
  storage: PendingOrderCommentStorage | null | undefined,
  draft: PendingOrderCommentDraft,
): boolean {
  const key = storageKeyFor(draft.userId, draft.orderId);
  const text = sanitizeText(draft.text);
  if (!storage || !key || !text) return false;

  try {
    storage.setItem(
      key,
      JSON.stringify({
        orderId: draft.orderId.trim(),
        userId: draft.userId.trim(),
        text,
        savedAt: Number.isFinite(draft.savedAt) ? Math.floor(draft.savedAt) : Date.now(),
      } satisfies PendingOrderCommentDraft),
    );
    return true;
  } catch {
    return false;
  }
}

/** Lee el borrador del usuario/pedido; un storage inaccesible cuenta como vacío. */
export function loadPendingOrderComment(
  storage: PendingOrderCommentStorage | null | undefined,
  userId: string | null | undefined,
  orderId: string | null | undefined,
): PendingOrderCommentDraft | null {
  const key = storageKeyFor(userId, orderId);
  if (!storage || !key) return null;

  try {
    const draft = parsePendingOrderComment(storage.getItem(key));
    if (!draft) return null;
    if (draft.userId !== userId?.trim() || draft.orderId !== orderId?.trim()) return null;
    return draft;
  } catch {
    return null;
  }
}

/** Elimina el borrador al enviarlo con éxito o al descartarlo. */
export function clearPendingOrderComment(
  storage: PendingOrderCommentStorage | null | undefined,
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
