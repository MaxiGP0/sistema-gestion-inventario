/**
 * Lógica pura compartida por el refresco en vivo del panel y de los detalles.
 *
 * El SSE de notificaciones se republica como `sgi:order-notification`
 * (`lib/order-notification-events.ts`). Estas funciones deciden *cuándo* vale
 * la pena volver a consultar y *qué* hacer con una lectura más nueva:
 *
 * - `createRefreshScheduler`: agrupa ráfagas de eventos en un refresco cada
 *   1,5 s (throttle con salida final) para no encadenar RSC/GET por cada alerta.
 * - `decideRemoteOrderUpdate`: aplica la lectura remota sólo si la versión
 *   avanzó y el usuario no tiene cambios locales; si los tiene, la deja
 *   pendiente para ofrecer "Cargar última versión" en vez de pisar el picking.
 *
 * No usa DOM ni React para poder probarse con `node:test`.
 */

/** Ventana mínima entre dos refrescos disparados por notificaciones. */
export const ORDER_REFRESH_THROTTLE_MS = 1_500;

/** Una pestaña oculta más tiempo que esto se pone al día al volver. */
export const ORDER_FOCUS_REFRESH_AFTER_MS = 30_000;

export interface RefreshSchedulerOptions {
  /** Frecuencia mínima entre refrescos (por defecto 1,5 s). */
  delayMs?: number;
  /** Se ejecuta cuando vence la ventana y hay al menos un pedido pendiente. */
  onRefresh: () => void;
  /** Reloj y timers inyectables para tests deterministas. */
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface RefreshScheduler {
  /** Pide un refresco; las ráfagas dentro de la ventana se agrupan. */
  request: () => void;
  /** Cancela el refresco pendiente (desmontaje). */
  cancel: () => void;
}

/**
 * Throttle con salida final: el primer pedido espera la ventana y los que
 * llegan mientras tanto se descartan porque ya hay un refresco programado.
 * A diferencia de un debounce clásico, una ráfaga continua no lo pospone
 * indefinidamente.
 */
export function createRefreshScheduler({
  delayMs = ORDER_REFRESH_THROTTLE_MS,
  onRefresh,
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}: RefreshSchedulerOptions): RefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRefreshAt: number | null = null;

  const cancel = () => {
    if (timer === null) return;
    cancelSchedule(timer);
    timer = null;
  };

  const request = () => {
    if (timer !== null) return;

    const wait = lastRefreshAt === null ? delayMs : Math.max(0, delayMs - (now() - lastRefreshAt));

    timer = schedule(() => {
      timer = null;
      lastRefreshAt = now();
      onRefresh();
    }, wait);
  };

  return { request, cancel };
}

/** Normaliza la versión optimista; los pedidos históricos no la informan. */
export function orderVersion(order: unknown): number {
  const version = (order as { version?: unknown } | null | undefined)?.version;

  return typeof version === 'number' && Number.isFinite(version) && version > 0 ? version : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (isRecord(value) && typeof value._id === 'string') return value._id.trim();
  return '';
}

function normalizedNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedPostControl(value: unknown): string {
  return normalizedText(value) || 'pendiente';
}

function sameAutoMergeItem(local: unknown, remote: unknown): boolean {
  if (!isRecord(local) || !isRecord(remote)) return false;

  return (
    normalizedId(local._id) === normalizedId(remote._id) &&
    normalizedId(local.productId) === normalizedId(remote.productId) &&
    normalizedNumber(local.requestedQuantity) === normalizedNumber(remote.requestedQuantity) &&
    normalizedNumber(local.verifiedQuantity) === normalizedNumber(remote.verifiedQuantity) &&
    Boolean(local.isPending) === Boolean(remote.isPending) &&
    normalizedText(local.pendingReason) === normalizedText(remote.pendingReason) &&
    normalizedPostControl(local.postControl) === normalizedPostControl(remote.postControl)
  );
}

/**
 * ¿La lectura remota sólo agregó comentarios y avanzó la versión?
 *
 * Se usa cuando el usuario tiene cambios locales pero la revalidación sólo
 * trajo actividad de otra persona en el panel de comentarios. En ese caso se
 * puede actualizar `version`/`comments` sin tocar el picking ni mostrar el
 * aviso de versión vencida. Cualquier cambio de estado, archivado o línea
 * (cantidades, pendiente, motivo o post-control) obliga a la decisión manual.
 */
export function canAutoMergeRemoteOrder(localOrder: unknown, remoteOrder: unknown): boolean {
  if (!isRecord(localOrder) || !isRecord(remoteOrder)) return false;

  if (localOrder.status !== remoteOrder.status) return false;
  if (Boolean(localOrder.archived) !== Boolean(remoteOrder.archived)) return false;

  const localItems = Array.isArray(localOrder.items) ? localOrder.items : [];
  const remoteItems = Array.isArray(remoteOrder.items) ? remoteOrder.items : [];
  if (localItems.length !== remoteItems.length) return false;

  return localItems.every((item, index) => sameAutoMergeItem(item, remoteItems[index]));
}

export type RemoteOrderUpdateDecision = 'ignore' | 'apply' | 'stale';

/**
 * Decide qué hacer con una lectura en segundo plano:
 * - `ignore`: no hay una versión nueva (o es más vieja).
 * - `apply`: avanzó y no hay cambios locales, se puede reemplazar la pintura.
 * - `stale`: avanzó pero el usuario tiene trabajo sin guardar; no se pisa y se
 *   le ofrece cargar la última versión.
 */
export function decideRemoteOrderUpdate({
  localVersion,
  remoteVersion,
  hasLocalChanges,
}: {
  localVersion: number | null | undefined;
  remoteVersion: number | null | undefined;
  hasLocalChanges: boolean;
}): RemoteOrderUpdateDecision {
  const local = orderVersion({ version: localVersion ?? undefined });
  const remote = orderVersion({ version: remoteVersion ?? undefined });

  if (remote <= local) return 'ignore';

  return hasLocalChanges ? 'stale' : 'apply';
}

/** ¿La pestaña estuvo oculta el tiempo suficiente para revalidar al volver? */
export function shouldRefreshAfterVisibility(hiddenForMs: number): boolean {
  return hiddenForMs > ORDER_FOCUS_REFRESH_AFTER_MS;
}

/** ¿El evento SSE corresponde al pedido que está montado en el detalle? */
export function orderNotificationTargetsOrder(
  detail: { orderId: string | null },
  orderId: string,
): boolean {
  return Boolean(orderId) && detail.orderId === orderId;
}
