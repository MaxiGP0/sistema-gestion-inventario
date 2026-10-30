/**
 * Puente entre el SSE de notificaciones y las bandejas de pedidos abiertas.
 *
 * `NotificationsBell` valida el evento SSE y lo republica como CustomEvent en
 * `window`; las bandejas escuchan sin acoplarse al stream ni duplicar la
 * conexión. El detalle es serializable y puro para poder probarlo sin DOM.
 */

import { notificationMatchesInbox } from './notification-inbox';
import { NOTIFICATION_TARGET_ROLES, type NotificationTargetRole } from './types/notification';

export const ORDER_NOTIFICATION_EVENT = 'sgi:order-notification';

export interface OrderNotificationEventDetail {
  targetRole: NotificationTargetRole;
  /** Pedido asociado; `null` si la notificación no referencia uno. */
  orderId: string | null;
}

function isNotificationTargetRole(value: unknown): value is NotificationTargetRole {
  return NOTIFICATION_TARGET_ROLES.includes(value as NotificationTargetRole);
}

/** Valida el `detail` de un CustomEvent antes de usarlo. */
export function parseOrderNotificationEventDetail(
  value: unknown,
): OrderNotificationEventDetail | null {
  if (!value || typeof value !== 'object') return null;

  const detail = value as { targetRole?: unknown; orderId?: unknown };
  if (!isNotificationTargetRole(detail.targetRole)) return null;

  return {
    targetRole: detail.targetRole,
    orderId: typeof detail.orderId === 'string' && detail.orderId ? detail.orderId : null,
  };
}

/** Publica el evento para las bandejas montadas en la misma pestaña. */
export function emitOrderNotification(detail: OrderNotificationEventDetail): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(
    new CustomEvent<OrderNotificationEventDetail>(ORDER_NOTIFICATION_EVENT, { detail }),
  );
}

/** Suscribe una bandeja al evento; devuelve la función para desuscribirse. */
export function subscribeToOrderNotifications(
  listener: (detail: OrderNotificationEventDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleEvent = (event: Event) => {
    const detail = parseOrderNotificationEventDetail(
      (event as CustomEvent<OrderNotificationEventDetail>).detail,
    );
    if (detail) listener(detail);
  };

  window.addEventListener(ORDER_NOTIFICATION_EVENT, handleEvent);
  return () => window.removeEventListener(ORDER_NOTIFICATION_EVENT, handleEvent);
}

/**
 * ¿El evento corresponde a la bandeja abierta? `all` funciona como comodín en
 * ambos sentidos, igual que en la campana y en `/api/events`.
 */
export function orderNotificationMatchesTray(
  trayRole: NotificationTargetRole,
  targetRole: NotificationTargetRole,
): boolean {
  return notificationMatchesInbox(trayRole, targetRole);
}
