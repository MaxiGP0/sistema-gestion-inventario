/**
 * Efectos secundarios de un pedido: notificación persistida + aviso SSE +
 * Web Push.
 *
 * Se ejecutan después de guardar el pedido y son best-effort a propósito: un
 * fallo de Mongo al crear la notificación, del bus SSE o de un servicio push
 * no debe convertir un POST/PUT ya persistido en un 500. El error queda en el
 * log y la respuesta sigue siendo exitosa.
 *
 * `publishOrderNotification` ya se invoca con `runAfterResponse`, así que el
 * envío de push tampoco bloquea la respuesta del alta.
 *
 * Para entrega garantizada (at-least-once) ver docs/atomicidad-pedidos.md:
 * patrón outbox con un dispatcher, o una transacción de Mongo si el despliegue
 * corre sobre replica set.
 */
import type { Types } from 'mongoose';
import { Notification } from '../models/Notification';
import { dispatchPushNotification } from './push-notifications';
import { broadcastEvent } from './sse';
import type { NotificationTargetRole } from './types/notification';

export type OrderNotificationTarget = NotificationTargetRole;

export interface OrderNotificationInput {
  title: string;
  message: string;
  targetRole: OrderNotificationTarget;
  /** Destinatario individual para la bandeja privada del vendedor. */
  targetUserId?: string;
  targetUsername?: string;
  orderId: Types.ObjectId | string;
}

/**
 * Crea la notificación y difunde el evento SSE sin propagar errores.
 * Nunca lanza: el llamador puede esperarla sin arriesgar la respuesta.
 */
export async function publishOrderNotification({
  title,
  message,
  targetRole,
  targetUserId,
  targetUsername,
  orderId,
}: OrderNotificationInput): Promise<void> {
  let eventId: string | undefined;
  let persisted = false;

  try {
    const notification = await Notification.create({
      title,
      message,
      targetRole,
      ...(targetUserId ? { targetUserId } : {}),
      ...(targetUsername ? { targetUsername } : {}),
      orderId,
    });
    eventId = notification?._id ? String(notification._id) : undefined;
    persisted = true;
  } catch (error) {
    console.error(`Error al crear la notificación de pedido para ${targetRole}:`, error);
  }

  try {
    broadcastEvent({
      type: 'notification',
      targetRole,
      ...(targetUserId ? { targetUserId: String(targetUserId) } : {}),
      ...(targetUsername ? { targetUsername } : {}),
      orderId: String(orderId),
      eventId,
    });
  } catch (error) {
    console.error(`Error al emitir el evento SSE de pedido para ${targetRole}:`, error);
  }

  // Web Push solo después de persistir la notificación. El dispatcher ya
  // captura sus propios errores; el try/catch protege la respuesta ante
  // cualquier fallo inesperado (por ejemplo, la carga de modelos).
  if (persisted) {
    try {
      await dispatchPushNotification({
        title,
        message,
        targetRole,
        targetUserId,
        targetUsername,
        orderId: String(orderId),
      });
    } catch (error) {
      console.error(`Error al enviar Web Push del pedido para ${targetRole}:`, error);
    }
  }
}
