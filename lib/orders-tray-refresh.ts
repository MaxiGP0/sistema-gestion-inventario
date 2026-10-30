/**
 * Aviso de una sola vez para que la bandeja destino se revalide al volver de
 * un detalle donde se guardó un cambio.
 *
 * El Router Cache de Next puede conservar el RSC de la bandeja con el estado
 * anterior al PUT/PATCH. El marcador viaja en `sessionStorage` (por pestaña) y
 * la bandeja lo consume al montar: pinta primero la data inicial y luego hace
 * un refresh en segundo plano, sin mostrar un spinner.
 */

const REFRESH_KEY_PREFIX = 'sgi_orders_tray_refresh:';

/** Un marcador viejo (navegación abandonada) no fuerza refrescos eternos. */
export const ORDERS_TRAY_REFRESH_TTL_MS = 60_000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;

  try {
    return window.sessionStorage;
  } catch {
    // Almacenamiento bloqueado (modo privado): se degrada a no revalidar.
    return null;
  }
}

/** Marca que la bandeja `path` debe refrescarse cuando se monte. */
export function markOrdersTrayForRefresh(
  path: string,
  now = Date.now(),
  storage?: StorageLike,
): void {
  const target = resolveStorage(storage);
  if (!target) return;

  try {
    target.setItem(`${REFRESH_KEY_PREFIX}${path}`, JSON.stringify({ at: now }));
  } catch {
    // Sin sessionStorage no se puede marcar; la navegación sigue funcionando.
  }
}

/**
 * Consume el marcador de `path`. Devuelve `true` una sola vez y descarta el
 * marcador vencido para que una navegación abandonada no refresque de más.
 */
export function consumeOrdersTrayRefresh(
  path: string,
  now = Date.now(),
  storage?: StorageLike,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;

  const key = `${REFRESH_KEY_PREFIX}${path}`;

  try {
    const raw = target.getItem(key);
    if (!raw) return false;

    target.removeItem(key);

    const parsed = JSON.parse(raw) as { at?: unknown };
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return false;

    return now - parsed.at <= ORDERS_TRAY_REFRESH_TTL_MS;
  } catch {
    return false;
  }
}
