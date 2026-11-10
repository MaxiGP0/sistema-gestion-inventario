/**
 * Actualización local de la campana con la carga útil del evento SSE.
 *
 * El servidor adjunta `notification` solo a la bandeja destinataria. Cuando el
 * payload es válido, `NotificationsBell` lo inserta sin pedir la lista
 * completa; si falta (servidor viejo) o la conexión se reabre, cae al GET.
 *
 * Este módulo es puro (sin DOM ni modelos) para poder probar la deduplicación,
 * el orden y el contador sin montar React.
 */

import {
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_TARGET_ROLES,
  type NotificationEventPayload,
  type NotificationTargetRole,
  type UserNotificationDTO,
} from './types/notification';

function isNotificationTargetRole(value: unknown): value is NotificationTargetRole {
  return NOTIFICATION_TARGET_ROLES.includes(value as NotificationTargetRole);
}

/** Valida la carga útil que llega en `data.notification`; `null` si no sirve. */
export function parseNotificationEventPayload(value: unknown): NotificationEventPayload | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id) return null;
  if (typeof candidate.title !== 'string') return null;
  if (typeof candidate.message !== 'string') return null;
  if (typeof candidate.createdAt !== 'string') return null;
  if (Number.isNaN(Date.parse(candidate.createdAt))) return null;
  if (!isNotificationTargetRole(candidate.targetRole)) return null;
  if (candidate.orderId !== undefined && typeof candidate.orderId !== 'string') return null;

  return {
    id: candidate.id,
    title: candidate.title,
    message: candidate.message,
    createdAt: candidate.createdAt,
    targetRole: candidate.targetRole,
    ...(candidate.orderId ? { orderId: candidate.orderId } : {}),
  };
}

/**
 * Inserta la notificación del evento al principio de la lista.
 *
 * - Deduplica por `id`: un replay o dos eventos del mismo pedido no duplican.
 * - Recorta a la página visible (o a lo ya cargado, si el usuario pidió más),
 *   para que la lista no crezca sin límite con la pestaña abierta.
 * - La notificación nueva siempre entra como no leída; el contador se deriva
 *   de la lista con `countUnreadNotifications`.
 */
export function applyLiveNotification(
  current: UserNotificationDTO[],
  payload: NotificationEventPayload,
  pageSize = NOTIFICATION_PAGE_SIZE,
): UserNotificationDTO[] {
  if (current.some((notification) => notification._id === payload.id)) {
    return current;
  }

  const incoming: UserNotificationDTO = {
    _id: payload.id,
    title: payload.title,
    message: payload.message,
    targetRole: payload.targetRole,
    ...(payload.orderId ? { orderId: payload.orderId } : {}),
    createdAt: payload.createdAt,
    read: false,
    readAt: null,
  };

  const limit = Math.max(pageSize, current.length);
  return [incoming, ...current].slice(0, limit);
}

/** Cantidad de notificaciones sin leer de la página visible. */
export function countUnreadNotifications(notifications: readonly UserNotificationDTO[]): number {
  return notifications.reduce((count, notification) => (notification.read ? count : count + 1), 0);
}
