import type { ApiMessageResponse, CursorPagination } from './common';

/** Bandejas de notificaciones: compartidas por rol y privada por vendedor. */
export const NOTIFICATION_TARGET_ROLES = ['deposit', 'billing', 'vendor', 'all'] as const;

export type NotificationTargetRole = (typeof NOTIFICATION_TARGET_ROLES)[number];

/** Cantidad de notificaciones que devuelve una página por defecto. */
export const NOTIFICATION_PAGE_SIZE = 30;

/**
 * Carga útil que viaja dentro del evento SSE de una bandeja destinataria.
 *
 * El servidor solo la adjunta a las conexiones cuya bandeja coincide con
 * `targetRole`; el resto recibe el evento liviano y hace un GET de respaldo.
 */
export interface NotificationEventPayload {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  targetRole: NotificationTargetRole;
  orderId?: string;
}

/** Notificación compartida (sin el estado de lectura del usuario). */
export interface NotificationDTO {
  _id: string;
  title: string;
  message: string;
  targetRole: NotificationTargetRole;
  /** Destinatario individual de una bandeja privada (`vendor`). */
  targetUserId?: string;
  targetUsername?: string;
  orderId?: string;
  createdAt: string;
}

/** Notificación con el estado leído/descartado del usuario autenticado. */
export interface UserNotificationDTO extends NotificationDTO {
  read: boolean;
  readAt: string | null;
}

/** `GET /api/notifications` */
export interface NotificationListResponse {
  success: true;
  notifications: UserNotificationDTO[];
  pagination: CursorPagination;
}

/** `POST /api/notifications` */
export interface NotificationCreateResponse {
  success: true;
  notification: NotificationDTO;
}

/** `GET /api/users/notifications` */
export interface UserNotificationListResponse {
  success: true;
  notifications: UserNotificationDTO[];
  inbox: NotificationTargetRole;
  notificationsEnabled: boolean;
  pagination: CursorPagination;
}

/** `PUT /api/users/notifications` */
export interface NotificationPreferenceResponse extends ApiMessageResponse {
  notificationsEnabled: boolean;
}
