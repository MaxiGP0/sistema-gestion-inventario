/**
 * Payload y destino de una notificación Web Push.
 *
 * Es un módulo puro para compartir el mismo criterio entre el dispatcher del
 * servidor y las pruebas. El service worker repite la resolución del destino
 * en `public/sw.js` porque corre en otro contexto y no puede importar TS.
 */

import type { NotificationTargetRole } from './types/notification';

export interface PushNotificationInput {
  title: string;
  message: string;
  targetRole: NotificationTargetRole;
  /** Destinatario individual de la bandeja privada del vendedor. */
  targetUserId?: string | null;
  targetUsername?: string | null;
  orderId?: string | null;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  targetRole: NotificationTargetRole;
  orderId?: string;
  /** Ruta interna que abre el clic en la notificación. */
  url: string;
}

/**
 * Ruta interna a abrir al tocar la notificación:
 * - depósito: `/deposit/orders` o `/deposit/orders/:id`
 * - facturación: `/billing/orders` o `/billing/orders/:id`
 * - vendedor: `/orders` o `/orders/:id` (su propia bandeja)
 * - global (`all`): el panel, porque el detalle es ambiguo entre bandejas.
 */
export function resolvePushDestination({
  targetRole,
  orderId,
}: {
  targetRole: NotificationTargetRole;
  orderId?: string | null;
}): string {
  if (targetRole === 'vendor') {
    return orderId ? `/orders/${encodeURIComponent(orderId)}` : '/orders';
  }

  if (targetRole !== 'deposit' && targetRole !== 'billing') return '/';

  const base = `/${targetRole}/orders`;
  return orderId ? `${base}/${encodeURIComponent(orderId)}` : base;
}

/** Objeto que se serializa como JSON en el envío. */
export function buildPushNotificationPayload({
  title,
  message,
  targetRole,
  orderId,
}: PushNotificationInput): PushNotificationPayload {
  const normalizedOrderId = orderId ? String(orderId) : undefined;

  return {
    title,
    body: message,
    targetRole,
    ...(normalizedOrderId ? { orderId: normalizedOrderId } : {}),
    url: resolvePushDestination({ targetRole, orderId: normalizedOrderId }),
  };
}
