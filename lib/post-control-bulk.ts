/**
 * Acciones masivas del control post-factura.
 *
 * Facturación puede marcar de una vez todas las líneas que siguen en
 * `pendiente`, sin tocar las que ya tienen `diferencia` (un faltante explícito
 * no debe convertirse en OK por accidente). El snapshot previo permite
 * deshacer la acción con otro PATCH.
 *
 * Módulo puro para compartir entre la UI y los tests.
 */
import {
  isPostControlPending,
  resolvePostControl,
  type PostControl,
  type PostControllableItem,
} from './order-post-control';

export interface PostControlItemLike extends PostControllableItem {
  _id: string;
}

export interface PostControlUpdate {
  _id: string;
  postControl: PostControl;
}

/** Estado previo por línea, para el botón "Deshacer". */
export type PostControlSnapshot = Record<string, PostControl>;

/** Guarda el control actual de cada línea antes de una acción masiva. */
export function snapshotPostControls(items: readonly PostControlItemLike[]): PostControlSnapshot {
  const snapshot: PostControlSnapshot = {};
  items.forEach((item) => {
    snapshot[item._id] = resolvePostControl(item.postControl);
  });
  return snapshot;
}

/**
 * Actualizaciones para marcar como OK sólo las líneas pendientes. Devuelve un
 * array vacío si ya no queda ninguna (el botón debe estar deshabilitado).
 */
export function buildMarkAllOkUpdates(items: readonly PostControlItemLike[]): PostControlUpdate[] {
  return items
    .filter((item) => isPostControlPending(item))
    .map((item) => ({ _id: item._id, postControl: 'ok' as const }));
}

/**
 * Actualizaciones para volver al snapshot previo. Sólo envía las líneas cuyo
 * control cambió desde entonces: evita tocar líneas que otro operario ya
 * actualizó y no incrementa la versión sin necesidad.
 */
export function buildRestorePostControlUpdates(
  items: readonly PostControlItemLike[],
  snapshot: PostControlSnapshot,
): PostControlUpdate[] {
  return items.reduce<PostControlUpdate[]>((updates, item) => {
    const previous = snapshot[item._id];
    if (previous === undefined) return updates;

    if (resolvePostControl(item.postControl) !== previous) {
      updates.push({ _id: item._id, postControl: previous });
    }
    return updates;
  }, []);
}
